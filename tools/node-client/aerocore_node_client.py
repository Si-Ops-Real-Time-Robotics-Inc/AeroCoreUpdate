#!/usr/bin/env python3
"""AeroCore node test client — a desktop stand-in for a node, talking to AeroCoreUpdate.

What it does, in the order a real node does it:

  1. Signs in to the proxy_alpha realm AS A NODE: authorization code + PKCE through the system
     browser, with the code handed back to a listener on 127.0.0.1 (RFC 8252). It uses the
     node's own public client, `aerocore-engine`, so the token carries aud=aerocore and the
     account's fleet role — exactly what the server checks. Passkeys, Google or the dev realm's
     username form all work, because the browser does the signing in, not this program.
  2. Asks /api/v1/update/check what it should run, as a given serial, platform, version, system
     and channel.
  3. Downloads the artifact the manifest names — resumable with Range — and does not call it
     done until the size and the sha256 match the manifest.

Standard library only. It is a test tool outside the server: it adds no route, no table and no
contract, and it keeps tokens in memory only — nothing is written to disk but the download.

Run:   python3 tools/node-client/aerocore_node_client.py
Needs: python3-tk (Ubuntu: sudo apt install python3-tk)
The server address is typed into the window; no address is built in. Use the host's name
(e.g. <hostname>.local), not its IP: Keycloak sends the browser to the name it was configured
with, whatever address you dialled. AEROCORE_SERVER_HOST pre-fills it, and AEROCORE_REALM, AEROCORE_CLIENT_ID and AEROCORE_SYSTEM set the other defaults.
"""
import base64
import hashlib
import html
import json
import os
import queue
import re
import secrets
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import tkinter as tk
    from tkinter import filedialog, ttk
except ImportError:  # the client core below works without it; only main() needs a window
    tk = ttk = filedialog = None

# No default address: the stack moves between machines, and a built-in IP that is silently wrong
# costs more than typing one. AeroCoreUpdate and Keycloak share the host, on these ports.
SERVER_PORT = 9443
KEYCLOAK_PORT = 8081

DEFAULTS = {
    "server_ip": os.environ.get("AEROCORE_SERVER_HOST", ""),
    "realm": os.environ.get("AEROCORE_REALM", "aerotunnel"),
    "client_id": os.environ.get("AEROCORE_CLIENT_ID", "aerocore-engine"),
    "system": os.environ.get("AEROCORE_SYSTEM", "HERA"),
}

# Mirrors KNOWN_PLATFORMS in src/domain/platform.js. The field stays editable: with
# STRICT_PLATFORMS off the server accepts any name matching its pattern.
PLATFORMS = [
    "linux-x86_64", "linux-aarch64", "linux-arm", "linux-x86",
    "windows-x86_64", "windows-aarch64", "windows-x86",
    "android-aarch64", "android-x86_64", "android-arm", "android-x86",
    "macos-x86_64", "macos-aarch64",
]
CHANNELS = ["stable", "beta"]


class ClientError(Exception):
    """A failure worth showing a person — the server's own message whenever it sent one."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def jwt_claims(token: str) -> dict:
    """A token's claims, NOT verified. For display only: the server is what verifies it."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError):
        return {}


def human_size(n) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _server_message(err: urllib.error.HTTPError) -> str:
    """The envelope's `message` (AeroCoreUpdate) or `error_description` (Keycloak)."""
    try:
        body = json.loads(err.read() or b"{}")
        if isinstance(body, dict):
            text = body.get("message") or body.get("error_description") or body.get("error")
            if text:
                return str(text)
    except (ValueError, OSError):
        pass
    return f"HTTP {err.code} {err.reason}"


@dataclass
class Session:
    access_token: str
    refresh_token: str | None
    expires_at: float
    claims: dict

    @classmethod
    def from_token_response(cls, body: dict) -> "Session":
        return cls(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token"),
            expires_at=time.time() + int(body.get("expires_in", 60)),
            claims=jwt_claims(body["access_token"]),
        )

    @property
    def username(self) -> str:
        return self.claims.get("preferred_username") or self.claims.get("sub", "?")

    @property
    def roles(self) -> list[str]:
        return list((self.claims.get("realm_access") or {}).get("roles", []))

    @property
    def audience(self) -> list[str]:
        aud = self.claims.get("aud")
        return aud if isinstance(aud, list) else ([aud] if aud else [])

    def seconds_left(self) -> int:
        return max(0, int(self.expires_at - time.time()))

    def fleet_policy(self) -> str:
        """What the realm roles say this account may pull. Display only — the server decides, and
        its 403 is the answer that counts."""
        if "aerocore-fleet" in self.roles:
            return "every channel, beta included (aerocore-fleet)"
        if "aerocore-fleet-stable" in self.roles:
            return "stable only (aerocore-fleet-stable)"
        return "nothing — this account has no fleet role, the server will refuse it"


class _Loopback:
    """One sign-in: PKCE, a state value, and a listener on 127.0.0.1 for the browser to return to.

    RFC 8252 §7.3. The node client registers `http://127.0.0.1:*`, so any free port works, and
    nothing is listening any more once the code has arrived.
    """

    def __init__(self, authorization_endpoint: str, client_id: str):
        self.verifier = b64url(secrets.token_bytes(48))
        self.state = b64url(secrets.token_bytes(16))
        self._outcome: queue.Queue = queue.Queue(maxsize=1)
        self._cancelled = threading.Event()
        state, outcome = self.state, self._outcome

        class Callback(BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path != "/callback":
                    self.send_error(404)
                    return
                q = dict(urllib.parse.parse_qsl(parsed.query))
                if q.get("state") != state:
                    result = ("error", "the callback did not belong to this sign-in (state mismatch)")
                elif "error" in q:
                    result = ("error", q.get("error_description") or q["error"])
                elif "code" in q:
                    result = ("code", q["code"])
                else:
                    result = ("error", "the callback carried no code")
                ok = result[0] == "code"
                page = (
                    "<!doctype html><meta charset=utf-8><title>AeroCore node test client</title>"
                    "<body style='font:15px system-ui;padding:2em'>"
                    f"<h2>{'Signed in' if ok else 'Sign-in failed'}</h2>"
                    f"<p>{'You can close this tab and go back to the test client.' if ok else html.escape(result[1])}</p>"
                ).encode()
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)
                try:
                    outcome.put_nowait(result)
                except queue.Full:
                    pass

            def log_message(self, *args):  # the query carries the code; keep it off stderr
                pass

        self._server: HTTPServer | None = HTTPServer(("127.0.0.1", 0), Callback)
        self.redirect_uri = f"http://127.0.0.1:{self._server.server_address[1]}/callback"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.authorize_url = authorization_endpoint + "?" + urllib.parse.urlencode({
            "client_id": client_id,
            "response_type": "code",
            "scope": "openid",
            "redirect_uri": self.redirect_uri,
            "state": self.state,
            "code_challenge": b64url(hashlib.sha256(self.verifier.encode()).digest()),
            "code_challenge_method": "S256",
        })

    def wait(self, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        while True:
            if self._cancelled.is_set():
                raise ClientError("Sign-in cancelled.")
            try:
                kind, value = self._outcome.get(timeout=0.25)
                break
            except queue.Empty:
                if time.monotonic() > deadline:
                    raise ClientError("Sign-in timed out: nothing came back from the browser.") from None
        if kind != "code":
            raise ClientError(f"Keycloak did not sign you in: {value}")
        return value

    def cancel(self):
        self._cancelled.set()

    def close(self):
        server, self._server = self._server, None
        if server:
            # shutdown() waits for serve_forever to notice; never block the caller on it.
            threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True).start()


class NodeClient:
    """Everything a node does over the wire, with no window involved."""

    def __init__(self, server: str, keycloak: str, realm: str, client_id: str,
                 verify_tls: bool = False, log=print):
        self.server = server.rstrip("/")
        self.issuer = f"{keycloak.rstrip('/')}/realms/{realm}"
        self.client_id = client_id
        self.log = log
        self.ctx = ssl.create_default_context()
        if not verify_tls:
            # The dev container's certificate is self-signed by design. Not verifying is a test
            # setting; fingerprint() shows what was accepted, to compare with `docker logs`.
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE
        self.session: Session | None = None
        self._oidc: dict | None = None
        self._login: _Loopback | None = None

    # ── transport ────────────────────────────────────────────────────────────
    def _open(self, method, url, headers=None, data=None, timeout=30):
        started = time.monotonic()
        shown = self._shown(url)
        req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
        try:
            resp = urllib.request.urlopen(req, context=self.ctx, timeout=timeout)
        except urllib.error.HTTPError as err:
            message = _server_message(err)
            self.log(f"{method} {shown} → {err.code} ({_ms(started)} ms): {message}")
            raise ClientError(message, err.code) from None
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", err)
            self.log(f"{method} {shown} → unreachable: {reason}")
            raise ClientError(f"Cannot reach {urllib.parse.urlparse(url).netloc}: {reason}") from None
        self.log(f"{method} {shown} → {resp.status} ({_ms(started)} ms)")
        return resp

    def _json(self, method, url, **kw):
        with self._open(method, url, **kw) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})

    def _shown(self, url: str) -> str:
        """A URL fit for the log: nothing in it that works as a credential."""
        u = urllib.parse.urlparse(url)
        query = [(k, "…" if k in ("code", "state", "code_verifier", "refresh_token") else v)
                 for k, v in urllib.parse.parse_qsl(u.query)]
        host = "" if url.startswith(self.server) else u.netloc
        return host + u.path + (f"?{urllib.parse.urlencode(query)}" if query else "")

    def _auth(self) -> dict:
        if not self.session:
            raise ClientError("Not signed in.")
        if self.session.seconds_left() < 20:
            self.refresh()
        return {"Authorization": f"Bearer {self.session.access_token}"}

    # ── the server and the realm ─────────────────────────────────────────────
    def health(self) -> str:
        try:
            _, body = self._json("GET", f"{self.server}/api/v1/health")
        except ClientError as err:
            if err.status in (401, 403):
                return "reachable (health wants a credential)"
            raise
        return f"up ({body.get('status', 'ok')})" if isinstance(body, dict) else "up"

    def fingerprint(self) -> str:
        """SHA-256 of the certificate this server presented — the container logs the same line."""
        u = urllib.parse.urlparse(self.server)
        if u.scheme != "https":
            return "(plain HTTP — no certificate)"
        with socket.create_connection((u.hostname, u.port or 443), timeout=8) as raw:
            with self.ctx.wrap_socket(raw, server_hostname=u.hostname) as tls:
                der = tls.getpeercert(binary_form=True)
        digest = hashlib.sha256(der).hexdigest().upper()
        return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))

    def oidc(self) -> dict:
        if self._oidc is None:
            _, self._oidc = self._json("GET", f"{self.issuer}/.well-known/openid-configuration")
        return self._oidc

    # ── signing in ───────────────────────────────────────────────────────────
    def begin_login(self) -> str:
        """Start listening on loopback; return the URL the browser has to open."""
        self.cancel_login()
        self._login = _Loopback(self.oidc()["authorization_endpoint"], self.client_id)
        return self._login.authorize_url

    @property
    def login_redirect_uri(self) -> str | None:
        return self._login.redirect_uri if self._login else None

    def finish_login(self, timeout: float = 300) -> Session:
        login = self._login
        if login is None:
            raise ClientError("No sign-in is in progress.")
        try:
            code = login.wait(timeout)
            body = urllib.parse.urlencode({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": login.redirect_uri,
                "client_id": self.client_id,
                "code_verifier": login.verifier,
            }).encode()
            _, tokens = self._json("POST", self.oidc()["token_endpoint"], data=body,
                                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        finally:
            login.close()
            if self._login is login:
                self._login = None
        self.session = Session.from_token_response(tokens)
        return self.session

    def cancel_login(self):
        if self._login:
            self._login.cancel()

    def refresh(self):
        s = self.session
        if not s or not s.refresh_token:
            raise ClientError("The token ran out and there is no refresh token — sign in again.")
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token", "refresh_token": s.refresh_token, "client_id": self.client_id,
        }).encode()
        _, tokens = self._json("POST", self.oidc()["token_endpoint"], data=body,
                               headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.session = Session.from_token_response(tokens)

    def sign_out(self):
        """End the realm session too, rather than only forgetting the token here."""
        s, self.session = self.session, None
        endpoint = (self._oidc or {}).get("end_session_endpoint")
        if s and s.refresh_token and endpoint:
            body = urllib.parse.urlencode({"client_id": self.client_id, "refresh_token": s.refresh_token}).encode()
            try:
                self._open("POST", endpoint, data=body,
                           headers={"Content-Type": "application/x-www-form-urlencoded"}).close()
            except ClientError as err:
                self.log(f"sign-out at the realm failed ({err}); the token here is forgotten anyway")

    # ── the node protocol ────────────────────────────────────────────────────
    def check(self, serial: str, platform: str, version: str, channel: str, system: str = "") -> dict:
        query = {"serial": serial, "platform": platform, "version": version, "channel": channel}
        if system:
            query["system"] = system
        _, manifest = self._json("GET", f"{self.server}/api/v1/update/check?{urllib.parse.urlencode(query)}",
                                 headers=self._auth())
        return manifest

    def download(self, manifest: dict, folder: str, progress=None, cancelled=None) -> str:
        """Fetch the artifact the manifest names into `folder`, and prove it is that artifact.

        Creates `folder` if it is not there. Resumable: bytes land in `<name>.part`, and a later
        call continues with a Range request.
        Done means the size AND the sha256 match the manifest — the checks a node makes before it
        installs anything. The manifest's signature is NOT verified here: that needs Ed25519,
        which the standard library does not have.
        """
        progress = progress or (lambda done, total: None)
        cancelled = cancelled or threading.Event()
        if not manifest.get("update_available"):
            raise ClientError("The manifest offers no update — there is nothing to download.")
        size, expected = int(manifest["size"]), str(manifest["sha256"]).lower()
        url = urllib.parse.urljoin(self.server + "/", manifest["url"])
        stem = f"aerocore-{manifest['version']}-{manifest.get('target') or 'artifact'}"
        final = os.path.join(folder, re.sub(r"[^A-Za-z0-9._-]", "_", stem) + ".tar.gz")
        part = final + ".part"
        os.makedirs(folder, exist_ok=True)

        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > size:  # not a prefix of this artifact any more
            os.remove(part)
            have = 0
        if have < size:
            headers = self._auth()
            if have:
                headers["Range"] = f"bytes={have}-"
            with self._open("GET", url, headers=headers, timeout=60) as resp:
                resumed = bool(have) and resp.status == 206 and \
                    resp.headers.get("Content-Range", "").startswith(f"bytes {have}-")
                if have and not resumed:
                    self.log(f"the server did not resume from byte {have}; starting over")
                    have = 0
                done = have
                progress(done, size)
                with open(part, "ab" if resumed else "wb") as out:
                    while True:
                        if cancelled.is_set():
                            raise ClientError(
                                f"Cancelled at {human_size(done)} of {human_size(size)}. The partial "
                                "file is kept; downloading again resumes from it.")
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        progress(done, size)
        return self._verify(part, final, size, expected)

    def _verify(self, part: str, final: str, size: int, expected: str) -> str:
        got = os.path.getsize(part)
        if got != size:
            raise ClientError(f"Got {human_size(got)}, the manifest says {human_size(size)}. "
                              "The partial file is kept; download again to resume.")
        digest = hashlib.sha256()
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            os.remove(part)
            raise ClientError(f"sha256 mismatch: got {digest.hexdigest()}, the manifest says {expected}. "
                              "The file was deleted — it is not the file the manifest describes.")
        os.replace(part, final)
        self.log(f"verified {os.path.basename(final)}: {size} bytes, sha256 {expected[:16]}…")
        return final


# ── the window ───────────────────────────────────────────────────────────────
class App:
    """Tk on one thread, the network on others. Workers never touch a widget: they queue a
    callable, and the Tk thread runs it (Tk is not thread-safe)."""

    def __init__(self, root):
        self.root = root
        root.title("AeroCore node test client")
        root.minsize(700, 400)
        self.ui: queue.Queue = queue.Queue()
        self.client: NodeClient | None = None
        self._cfg = None
        self.manifest: dict | None = None
        self.cancel_download = threading.Event()
        self.logging_in = False
        self.downloading = False

        values = {
            "server_ip": DEFAULTS["server_ip"], "server": "", "keycloak": "",
            "realm": DEFAULTS["realm"], "client_id": DEFAULTS["client_id"],
            "serial": f"TEST-{socket.gethostname()}", "platform": "linux-x86_64",
            "version": "0.0.1", "system": DEFAULTS["system"], "channel": "stable",
            "folder": os.path.join(os.path.expanduser("~"), "Downloads", "aerocore-node-test"),
            "conn": "Not tested yet.", "who": "Not signed in.", "policy": "", "expiry": "",
            "result": "", "progress_text": "", "verdict": "",
        }
        self.var = {k: tk.StringVar(value=v) for k, v in values.items()}
        self.insecure = tk.BooleanVar(value=True)

        style = ttk.Style()
        style.configure("Good.TLabel", foreground="#1b5e20")
        style.configure("Bad.TLabel", foreground="#b00020")
        style.configure("Mono.TLabel", font="TkFixedFont")

        self._build()
        self._set_state()
        root.after(80, self._drain)
        root.after(1000, self._tick)

    # ── layout ───────────────────────────────────────────────────────────────
    def _field(self, parent, label, key, row, col, span=1, values=None):
        ttk.Label(parent, text=label).grid(row=row, column=col, sticky="w", padx=6, pady=3)
        if values is None:
            widget = ttk.Entry(parent, textvariable=self.var[key])
        else:
            widget = ttk.Combobox(parent, textvariable=self.var[key], values=values)
        widget.grid(row=row, column=col + 1, columnspan=span, sticky="ew", padx=6, pady=3)
        return widget

    def _build(self):
        # Controls on the left, the request log beside them: stacked, the log alone pushed the
        # Download section off a laptop screen. The controls also scroll, because a manifest
        # adds lines and some screens are shorter than any fixed layout.
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        panes = ttk.PanedWindow(self.root, orient="horizontal")
        panes.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        left = ttk.Frame(panes)
        left.columnconfigure(0, weight=1)
        left.rowconfigure(0, weight=1)
        panes.add(left, weight=0)
        canvas = tk.Canvas(left, highlightthickness=0, borderwidth=0)
        vbar = ttk.Scrollbar(left, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=vbar.set)
        canvas.grid(row=0, column=0, sticky="nsew")
        vbar.grid(row=0, column=1, sticky="ns")
        outer = ttk.Frame(canvas, padding=(0, 0, 6, 0))
        outer.columnconfigure(0, weight=1)
        inner = canvas.create_window(0, 0, window=outer, anchor="nw")
        outer.bind("<Configure>", lambda e: canvas.configure(
            scrollregion=canvas.bbox("all"), width=outer.winfo_reqwidth(), height=outer.winfo_reqheight()))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(inner, width=e.width))
        self._wheel_scrolls(canvas)
        self.controls = canvas

        srv = ttk.LabelFrame(outer, text="Server", padding=8)
        srv.grid(row=0, column=0, sticky="ew")
        srv.columnconfigure(1, weight=1)
        srv.columnconfigure(3, weight=1)
        self._field(srv, "Server address", "server_ip", 0, 0, span=3)
        for r, (label, key) in enumerate((("Update server", "server"), ("Keycloak", "keycloak")), start=1):
            ttk.Label(srv, text=label).grid(row=r, column=0, sticky="w", padx=6, pady=3)
            ttk.Label(srv, textvariable=self.var[key], style="Mono.TLabel").grid(
                row=r, column=1, columnspan=3, sticky="w", padx=6, pady=3)
        self.var["server_ip"].trace_add("write", lambda *_: self._derive_urls())
        self._derive_urls()
        self._field(srv, "Realm", "realm", 3, 0)
        self._field(srv, "Client ID", "client_id", 3, 2)
        ttk.Checkbutton(srv, text="Don't verify the TLS certificate (self-signed dev server)",
                        variable=self.insecure).grid(row=4, column=0, columnspan=4, sticky="w", padx=6)
        row = ttk.Frame(srv)
        row.grid(row=5, column=0, columnspan=4, sticky="ew", pady=(4, 0))
        self.btn_test = ttk.Button(row, text="Test connection", command=self.on_test)
        self.btn_test.pack(side="left", padx=6)
        ttk.Label(row, textvariable=self.var["conn"], wraplength=440, justify="left").pack(side="left", fill="x")

        auth = ttk.LabelFrame(outer, text="Sign in as a node", padding=8)
        auth.grid(row=1, column=0, sticky="ew", pady=6)
        buttons = ttk.Frame(auth)
        buttons.grid(row=0, column=0, sticky="w")
        self.btn_login = ttk.Button(buttons, text="Sign in with Keycloak…", command=self.on_login)
        self.btn_cancel_login = ttk.Button(buttons, text="Cancel", command=self.on_cancel_login)
        self.btn_logout = ttk.Button(buttons, text="Sign out", command=self.on_logout)
        for b in (self.btn_login, self.btn_cancel_login, self.btn_logout):
            b.pack(side="left", padx=6)
        ttk.Label(auth, textvariable=self.var["who"], wraplength=560, justify="left").grid(
            row=1, column=0, sticky="w", padx=6, pady=(6, 0))
        ttk.Label(auth, textvariable=self.var["policy"]).grid(row=2, column=0, sticky="w", padx=6)
        ttk.Label(auth, textvariable=self.var["expiry"]).grid(row=3, column=0, sticky="w", padx=6)

        node = ttk.LabelFrame(outer, text="Node", padding=8)
        node.grid(row=2, column=0, sticky="ew", pady=6)
        node.columnconfigure(1, weight=1)
        node.columnconfigure(3, weight=1)
        self._field(node, "Serial", "serial", 0, 0)
        self._field(node, "Platform", "platform", 0, 2, values=PLATFORMS)
        self._field(node, "Current version", "version", 1, 0)
        self._field(node, "System", "system", 1, 2)
        self._field(node, "Channel", "channel", 2, 0, values=CHANNELS)
        self.btn_check = ttk.Button(node, text="Check for update", command=self.on_check)
        self.btn_check.grid(row=2, column=2, columnspan=2, sticky="w", padx=6)
        self.result = ttk.Label(node, textvariable=self.var["result"], wraplength=560, justify="left",
                                style="Mono.TLabel")
        self.result.grid(row=3, column=0, columnspan=4, sticky="w", padx=6, pady=(6, 0))

        dl = ttk.LabelFrame(outer, text="Download", padding=8)
        dl.grid(row=3, column=0, sticky="ew", pady=6)
        dl.columnconfigure(1, weight=1)
        self._field(dl, "Save to", "folder", 0, 0)
        ttk.Button(dl, text="Browse…", command=self.on_browse).grid(row=0, column=2, padx=6)
        bar = ttk.Frame(dl)
        bar.grid(row=1, column=0, columnspan=3, sticky="ew", pady=4)
        bar.columnconfigure(2, weight=1)
        self.btn_download = ttk.Button(bar, text="Download", command=self.on_download)
        self.btn_download.grid(row=0, column=0, padx=6)
        self.btn_cancel_dl = ttk.Button(bar, text="Cancel", command=self.cancel_download.set)
        self.btn_cancel_dl.grid(row=0, column=1, padx=6)
        self.progress = ttk.Progressbar(bar, mode="determinate")
        self.progress.grid(row=0, column=2, sticky="ew", padx=6)
        ttk.Label(dl, textvariable=self.var["progress_text"]).grid(row=2, column=0, columnspan=3, sticky="w", padx=6)
        self.verdict = ttk.Label(dl, textvariable=self.var["verdict"], wraplength=560, justify="left")
        self.verdict.grid(row=3, column=0, columnspan=3, sticky="w", padx=6)

        logf = ttk.LabelFrame(panes, text="Requests", padding=6)
        panes.add(logf, weight=1)
        logf.columnconfigure(0, weight=1)
        logf.rowconfigure(0, weight=1)
        self.log_text = tk.Text(logf, width=60, height=10, wrap="none", state="disabled", font="TkFixedFont")
        scroll = ttk.Scrollbar(logf, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scroll.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll.grid(row=0, column=1, sticky="ns")
        self._fit_to_screen()

    def _wheel_scrolls(self, canvas):
        """The wheel scrolls the controls only while the pointer is over them — bound globally it
        would also swallow the wheel in the request log."""
        def wheel(e):
            if canvas.yview() != (0.0, 1.0):
                canvas.yview_scroll(-1 if (e.num == 4 or e.delta > 0) else 1, "units")
        def bind(_):
            for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
                canvas.bind_all(seq, wheel)
        def unbind(_):
            for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
                canvas.unbind_all(seq)
        canvas.bind("<Enter>", bind)
        canvas.bind("<Leave>", unbind)

    def _reveal_download(self):
        """The manifest just grew the column; scroll to its end so Download is on screen. The
        scroll region is recomputed first — it is otherwise updated a beat later, and scrolling to
        the end of the old region stops short of the button."""
        self.root.update_idletasks()
        self.controls.configure(scrollregion=self.controls.bbox("all"))
        self.controls.yview_moveto(1.0)

    def _fit_to_screen(self):
        """Open at the size the layout asks for, but never larger than the screen: a window taller
        than the screen hides its bottom edge, which is where Download is."""
        self.root.update_idletasks()
        w = min(self.root.winfo_reqwidth(), self.root.winfo_screenwidth() - 60)
        h = min(self.root.winfo_reqheight(), self.root.winfo_screenheight() - 100)
        self.root.geometry(f"{w}x{h}+20+20")

    # ── plumbing ─────────────────────────────────────────────────────────────
    def _drain(self):
        for _ in range(200):
            try:
                self.ui.get_nowait()()
            except queue.Empty:
                break
        self.root.after(80, self._drain)

    def _log(self, line: str):
        """Safe from any thread."""
        stamp = time.strftime("%H:%M:%S")
        self.ui.put(lambda text=f"{stamp}  {line}\n": self._append(text))

    def _append(self, text: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _bg(self, work, done, failed):
        def run():
            try:
                result = work()
            except ClientError as err:
                self.ui.put(lambda e=err: failed(e))
            except Exception as err:  # a fault in this tool, not an answer from the server
                self.ui.put(lambda e=ClientError(f"{type(err).__name__}: {err}"): failed(e))
            else:
                self.ui.put(lambda r=result: done(r))
        threading.Thread(target=run, daemon=True).start()

    def _derive_urls(self):
        ip = self.var["server_ip"].get().strip()
        self.var["server"].set(f"https://{ip}:{SERVER_PORT}" if ip else "— enter the server address —")
        self.var["keycloak"].set(f"http://{ip}:{KEYCLOAK_PORT}" if ip else "")

    def _client(self) -> NodeClient:
        cfg = (self.var["server"].get().strip(), self.var["keycloak"].get().strip(),
               self.var["realm"].get().strip(), self.var["client_id"].get().strip(), self.insecure.get())
        if self.client is None or cfg != self._cfg:
            if self.client and self.client.session:
                self._log("server settings changed — the previous session is dropped")
                self.var["who"].set("Not signed in.")
                self.var["policy"].set("")
            self.client = NodeClient(*cfg[:4], verify_tls=not cfg[4], log=self._log)
            self._cfg = cfg
            self.manifest = None
        return self.client

    def _set_state(self):
        signed = bool(self.client and self.client.session)

        def enable(button, on):
            button.state(["!disabled"] if on else ["disabled"])

        enable(self.btn_login, not signed and not self.logging_in)
        enable(self.btn_cancel_login, self.logging_in)
        enable(self.btn_logout, signed)
        enable(self.btn_check, signed and not self.downloading)
        enable(self.btn_download, signed and not self.downloading
               and bool(self.manifest and self.manifest.get("update_available")))
        enable(self.btn_cancel_dl, self.downloading)

    def _tick(self):
        s = self.client.session if self.client else None
        if s:
            minutes, seconds = divmod(s.seconds_left(), 60)
            self.var["expiry"].set(f"Token valid for {minutes}:{seconds:02d} — refreshed automatically before it runs out.")
        else:
            self.var["expiry"].set("")
        self.root.after(1000, self._tick)

    # ── actions ──────────────────────────────────────────────────────────────
    def on_test(self):
        if not self.var["server_ip"].get().strip():
            self.var["conn"].set("✗ Enter the server address first.")
            return
        client = self._client()
        self.var["conn"].set("Testing…")

        def work():
            health = client.health()
            fingerprint = client.fingerprint()
            client.oidc()  # sign-in needs the realm too, so say now if it is not there
            return health, fingerprint

        def done(r):
            self.var["conn"].set(f"Server {r[0]} · realm reachable\nTLS certificate SHA-256 {r[1]}\n"
                                 "Compare: docker logs aerocoreupdate | grep fingerprint")

        self._bg(work, done, lambda e: self.var["conn"].set(f"✗ {e}"))

    def on_login(self):
        if not self.var["server_ip"].get().strip():
            self.var["who"].set("✗ Enter the server address first.")
            return
        client = self._client()
        self.logging_in = True
        self.var["who"].set("Opening your browser — sign in there, then come back here.")
        self._set_state()

        def work():
            url = client.begin_login()
            self._log(f"sign-in: browser → {url.split('?')[0]} · code comes back to {client.login_redirect_uri}")
            if not webbrowser.open(url):
                self._log("no browser could be opened; open this link yourself:\n    " + url)
            return client.finish_login(timeout=300)

        def done(_session):
            self.logging_in = False
            self._show_session()
            self._set_state()

        def failed(err):
            self.logging_in = False
            self.var["who"].set(f"Not signed in — {err}")
            self._set_state()

        self._bg(work, done, failed)

    def on_cancel_login(self):
        if self.client:
            self.client.cancel_login()

    def on_logout(self):
        client = self._client()

        def done(_):
            self.manifest = None
            self.var["who"].set("Signed out.")
            self.var["policy"].set("")
            self.var["result"].set("")
            self._set_state()

        self._bg(client.sign_out, done, lambda e: done(None))

    def _show_session(self):
        s = self.client.session
        mine = [r for r in s.roles if r.startswith(("aerocore", "aeroserver"))]
        self.var["who"].set(f"Signed in as {s.username} · audience {', '.join(s.audience) or '—'} · "
                            f"roles {', '.join(mine) or '—'}")
        policy = f"May pull: {s.fleet_policy()}"
        if "aerocore" not in s.audience:
            policy += "  ⚠ this token is not for the fleet (no 'aerocore' audience) — the server will refuse it"
        self.var["policy"].set(policy)

    def on_check(self):
        client = self._client()
        fields = [self.var[k].get().strip() for k in ("serial", "platform", "version", "channel", "system")]
        if not all(fields[:4]):
            self.result.configure(style="Bad.TLabel")
            self.var["result"].set("Serial, platform, current version and channel are all needed.")
            return
        self.var["result"].set("Asking the server…")
        self.result.configure(style="Mono.TLabel")

        def failed(err):
            self.manifest = None
            self.result.configure(style="Bad.TLabel")
            self.var["result"].set(f"Refused ({err.status}): {err}" if err.status else str(err))
            self._set_state()

        self._bg(lambda: client.check(*fields), self._show_manifest, failed)

    def _show_manifest(self, m: dict):
        self.manifest = m
        self.result.configure(style="Mono.TLabel")
        if not m.get("update_available"):
            follows = ", ".join(m.get("channels") or []) or "—"
            self.var["result"].set(
                f"No update: nothing newer than {self.var['version'].get()} on "
                f"{self.var['channel'].get()} for {self.var['platform'].get()}.\n"
                f"Channels this node may follow: {follows}")
        else:
            signature = m.get("signature")
            key = signature.get("key_id") if isinstance(signature, dict) else None
            self.var["result"].set("\n".join([
                f"Update available: {m['version']}   {human_size(m.get('size'))}   target {m.get('target')}",
                f"sha256    {m.get('sha256')}",
                f"mandatory {m.get('mandatory')}   min_version {m.get('min_version') or '—'}   "
                f"published {m.get('published_at') or '—'}",
                f"signature {'present' + (f' (key {key})' if key else '') if signature else 'MISSING'}"
                "   — not verified here (no Ed25519 in the standard library)",
                f"notes     {(m.get('notes') or '—')[:100]}",
            ]))
            self._reveal_download()
        self._set_state()

    def on_browse(self):
        chosen = filedialog.askdirectory(initialdir=self.var["folder"].get() or os.path.expanduser("~"))
        if chosen:
            self.var["folder"].set(chosen)

    def on_download(self):
        client, m = self._client(), self.manifest
        folder = self.var["folder"].get().strip() or os.getcwd()
        self.cancel_download.clear()
        self.downloading = True
        self.verdict.configure(style="TLabel")
        self.var["verdict"].set("")
        self.progress.configure(maximum=max(1, int(m.get("size") or 1)), value=0)
        self._set_state()
        started, first, last = time.monotonic(), [None], [0.0]

        def progress(done, total):
            now = time.monotonic()
            if first[0] is None:
                first[0] = done  # resumed bytes are not this run's speed
            if now - last[0] < 0.1 and done < total:
                return
            last[0] = now
            rate = (done - first[0]) / max(now - started, 1e-6)
            self.ui.put(lambda d=done, t=total, r=rate: self._show_progress(d, t, r))

        def work():
            return client.download(m, folder, progress, self.cancel_download)

        def done(path):
            self.downloading = False
            self.verdict.configure(style="Good.TLabel")
            self.var["verdict"].set(f"✓ Verified — size and sha256 match the manifest.\n{path}")
            self._set_state()

        def failed(err):
            self.downloading = False
            self.verdict.configure(style="Bad.TLabel")
            self.var["verdict"].set(f"✗ {err}")
            self._set_state()

        self._bg(work, done, failed)

    def _show_progress(self, done, total, rate):
        self.progress.configure(value=done)
        percent = int(done * 100 / total) if total else 0
        self.var["progress_text"].set(
            f"{percent}% · {human_size(done)} of {human_size(total)} · {human_size(rate)}/s")


def main():
    if tk is None:
        sys.exit("tkinter is not installed. On Ubuntu: sudo apt install python3-tk")
    try:
        root = tk.Tk()
    except tk.TclError as err:
        sys.exit(f"No display to open a window on ({err}). Run this from a desktop session.")
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
