import type { components, operations } from "@/api/schema";
import { accessToken, dropSession } from "./auth";

/**
 * Every shape below is generated from api/openapi.yaml by `npm run generate:api`.
 * Hand-written copies are how a client and a server quietly disagree: three of
 * these were wrong when they were guessed from the UI's fetch calls.
 */
type S = components["schemas"];

/** What a successful removal returns — read from the contract, not written again here. */
export type ReleaseRemoved =
  operations["deleteRelease"]["responses"][200]["content"]["application/json"];
export type ArtifactRemoved =
  operations["deleteArtifact"]["responses"][200]["content"]["application/json"];

export type Me = S["Me"];
export type Catalog = S["Catalog"];
export type System = S["System"];
export type Channel = S["Channel"];
export type Artifact = S["Artifact"];
export type StagedUpload = S["StagedUpload"];
export type CommittedUpload = S["CommittedUpload"];
export type Inspection = S["Inspection"];
export type Diff = S["Diff"];
export type Finding = S["Finding"];
export type ErrorCode = S["ErrorCode"];
export type OidcStatus = S["OidcStatus"];
export type ChannelMoved = S["ChannelMoved"];
export type RolloutStat = S["RolloutStat"];
export type NodeReport = S["NodeReport"];

/** The rollout endpoint's own envelope: a roll-up plus the most recent rows. */
export interface Reports {
  version: string | null;
  stats: RolloutStat[];
  recent: NodeReport[];
}

/**
 * Thin client over the admin API.
 *
 * Same shape as proxy-alpha/webui/src/lib/api.ts, with one deliberate
 * difference: the error document. The platform gateway speaks RFC 9457
 * (`type`/`title`/`detail`), while this server answers `{ code, message,
 * details }` — `code` comes from the closed enum the node protocol defines
 * (src/core/errors.js), because the same error path serves both /api/v1 for
 * aircraft and /admin/api for this UI, and the node's enum is the one that
 * cannot change.
 *
 * Branch on `code`, never on `message`. `message` is prose for a person and gets
 * reworded; `code` is the contract.
 */

/** Same origin in production: the Node server serves this bundle itself. */
const BASE = "/admin/api";

export interface Problem {
  status: number;
  code: ErrorCode | string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
    this.name = "ApiError";
  }
  get code(): string {
    return this.problem.code;
  }
  get status(): number {
    return this.problem.status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // Cookie-bearing endpoints on this server refuse a request without it — a
  // plain HTML form cannot set a custom header, which is what makes it a CSRF
  // defence. Harmless on the endpoints that use Authorization instead.
  headers.set("X-Requested-With", "fetch");

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (res.status === 401 && token) {
    // We sent a token and the server would not have it: expired, or minted by a
    // realm that has since been rebuilt. Drop it rather than rendering an admin
    // page in which every call fails.
    await dropSession();
    window.location.replace("/admin/");
    throw new ApiError({ status: 401, code: "unauthorized", message: "Session expired" });
  }

  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: body?.error ?? "server_error",
      message: body?.message ?? res.statusText,
      details: body?.details,
    });
  }
  return body as T;
}

// ── sign-in ──────────────────────────────────────────────────────────

export const api = {
  me: () => request<Me>("/auth/me"),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  /** Whether the sign-in page should offer Keycloak, asked of the server. */
  oidcStatus: () => request<OidcStatus>("/auth/oidc"),

  registrationStatus: () => request<{ enabled: boolean }>("/auth/registration"),

  // ── catalog ────────────────────────────────────────────────────────
  catalog: () => request<Catalog>("/catalog"),
  artifact: (id: string) => request<unknown>(`/artifacts/${encodeURIComponent(id)}`),
  // A release lives under its system: two systems may share a version number.
  updateRelease: (system: string, version: string, body: unknown) =>
    request<unknown>(`/systems/${encodeURIComponent(system)}/releases/${encodeURIComponent(version)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** A release and every artifact in it. Refused while any channel serves it. */
  deleteRelease: (system: string, version: string) =>
    request<ReleaseRemoved>(
      `/systems/${encodeURIComponent(system)}/releases/${encodeURIComponent(version)}`,
      { method: "DELETE" },
    ),
  /** One artifact. Refused while any channel serves the release it belongs to. */
  deleteArtifact: (id: number) =>
    request<ArtifactRemoved>(`/artifacts/${encodeURIComponent(String(id))}`, { method: "DELETE" }),

  // ── systems and channels ───────────────────────────────────────────
  systems: () => request<{ systems: System[] }>("/systems"),
  createSystem: (body: { name: string; description?: string }) =>
    request<System>("/systems", { method: "POST", body: JSON.stringify(body) }),
  deleteSystem: (name: string) =>
    request<void>(`/systems/${encodeURIComponent(name)}`, { method: "DELETE" }),

  getChannel: (system: string, channel: string) =>
    request<Channel>(
      `/systems/${encodeURIComponent(system)}/channels/${encodeURIComponent(channel)}`,
    ),

  /**
   * Moving a channel is the single action that reaches an aircraft.
   *
   * The field is `latest`, not `version`: the server refuses anything else with "nothing to
   * change: send latest". It had been `version` here since this client was written and no
   * screen had called it yet, so nothing had found out.
   *
   * `allowRollback` is the answer to the server's backward-move refusal, never a default and
   * never something this client decides on its own.
   */
  setChannel: (
    system: string,
    channel: string,
    latest: string,
    { allowRollback = false }: { allowRollback?: boolean } = {},
  ) =>
    request<ChannelMoved>(
      `/systems/${encodeURIComponent(system)}/channels/${encodeURIComponent(channel)}`,
      {
        method: "PUT",
        body: JSON.stringify(allowRollback ? { latest, allow_rollback: true } : { latest }),
      },
    ),

  // ── publishing ─────────────────────────────────────────────────────
  uploads: (query = "") => request<unknown>(`/uploads${query}`),
  /**
   * Step two. Takes no channel — the server puts it on `beta` and this screen
   * cannot name anywhere else. `allowRollback` answers the one refusal it can
   * receive: that `beta` would move backwards.
   */
  commitUpload: (token: string, allowRollback = false) =>
    request<CommittedUpload>(
      `/uploads/${encodeURIComponent(token)}${allowRollback ? "?allow_rollback=true" : ""}`,
      { method: "POST" },
    ),

  // ── rollout ────────────────────────────────────────────────────────
  reports: (version?: string) =>
    request<Reports>(`/reports${version ? `?version=${encodeURIComponent(version)}` : ""}`),

  // ── fleet ──────────────────────────────────────────────────────────
  fleet: () => request<unknown>("/fleet"),
  unclassified: () => request<unknown>("/unclassified"),
  placeNode: (serial: string, system: string) =>
    request<unknown>(`/unclassified/${encodeURIComponent(serial)}`, {
      method: "PUT",
      body: JSON.stringify({ system }),
    }),

  // ── security ───────────────────────────────────────────────────────
  users: () => request<unknown>("/users"),
  apiKeys: () => request<unknown>("/api-keys"),
  audit: (limit = 100) => request<unknown>(`/audit?limit=${limit}`),
  signingKey: () => request<{ key_id: string; public_key: string }>("/signing-key"),
  tls: () => request<{ fingerprint: string }>("/tls"),
};
