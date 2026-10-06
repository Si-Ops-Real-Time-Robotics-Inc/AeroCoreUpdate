# AeroCore node test client

A desktop stand-in for an AeroCore node, for testing AeroCoreUpdate by hand. It signs in to the
proxy_alpha realm the way a node does, asks the server what it should run, and downloads the
artifact — verifying its size and sha256 before calling it done.

It is a test tool, not part of the server: no route, no table, no contract. Standard library
only; tokens stay in memory.

## Run

```bash
python3 tools/node-client/aerocore_node_client.py
```

Needs `python3-tk` (Ubuntu: `sudo apt install python3-tk`) and a desktop session.

Type the server address into the **Server address** field — there is no address built into
the code. Use the host's **name**, e.g. `bug-vmware-virtual-platform.local`, not its IP:
Keycloak always sends the browser to the name it is configured with (`ATP_HOST` in
proxy-alpha), whichever address you dialled, and a name survives the IP changing. The window
derives the update server as `https://<address>:9443` and Keycloak as `http://<address>:8081`.

Defaults that can be set through the environment:

| Variable | Default |
|---|---|
| `AEROCORE_SERVER_HOST` | *(empty — type it in the window)* |
| `AEROCORE_REALM` | `aerotunnel` |
| `AEROCORE_CLIENT_ID` | `aerocore-engine` |
| `AEROCORE_SYSTEM` | `HERA` |

## What each step does

1. **Test connection** — `GET /api/v1/health`, the realm's discovery document, and the SHA-256
   of the certificate the server presented. The container logs the same fingerprint:
   `docker logs aerocoreupdate | grep fingerprint`. Compare them before trusting a self-signed
   server.
2. **Sign in with Keycloak** — opens your browser at the realm (authorization code + PKCE) and
   takes the code back on a listener at `http://127.0.0.1:<free port>/callback` (RFC 8252). The
   client is the node's own, `aerocore-engine`, which registers `http://127.0.0.1:*`, so the
   token carries `aud=aerocore` and the account's fleet role. Passkeys and Google work because
   the browser does the signing in.
3. **Check for update** — `GET /api/v1/update/check` as the serial, platform, version, system
   and channel in the form.
4. **Download** — the URL from the manifest, into `<name>.part`; Cancel keeps the part and the
   next Download resumes with `Range`. Done only when size and sha256 match the manifest. The
   manifest's signature is shown but not verified: that needs Ed25519, which the standard
   library does not have.

## What to expect per account

The server applies the channel policy of the account the node signed in with:

| Account | Fleet role | beta | stable |
|---|---|---|---|
| `admin@rtrobotics.com`, `engineer@rtrobotics.com` | `aerocore-fleet` | ✓ | ✓ |
| `pilot@rtrobotics.com` | `aerocore-fleet-stable` | 403 | ✓ |

A 403 is shown with the server's own message — that refusal is the thing being tested, not a
fault in the tool.
