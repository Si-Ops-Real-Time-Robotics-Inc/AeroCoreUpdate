import type { components } from "@/api/schema";

type S = components["schemas"];
export type Scope = S["Scope"];
export type Me = S["Me"];

/**
 * What a signed-in account may do, read from `/auth/me`.
 *
 * This is presentation, not security — the server refuses regardless, and must
 * keep doing so. What it buys is that an operator is not shown a button whose
 * only outcome is a refusal, which reads as a broken page rather than as a
 * permission nobody granted.
 *
 * The asymmetry is the point and is worth stating where it is used: filling the
 * catalog and shipping to an aircraft are different rights, and only an admin
 * holds both.
 */
export function has(me: Me | undefined | null, scope: Scope): boolean {
  return Boolean(me?.scopes?.includes(scope));
}

/** May add to the catalog: upload a bundle and commit it onto the staging channel. */
export const canPublish = (me?: Me | null) => has(me, "artifact:write");

/**
 * May point a channel at a release — the only right in this system that reaches an aircraft.
 * Deliberately NOT implied by canPublish: an account holding both is an admin, and that is
 * the whole asymmetry.
 */
export const canPromote = (me?: Me | null) => has(me, "channel:write");

/** May create or remove a system — a version line, not a pointer. */
export const canEditSystems = (me?: Me | null) => has(me, "system:write");

/** May read the catalog at all. Everything on these screens needs at least this. */
export const canRead = (me?: Me | null) => has(me, "catalog:read");

/**
 * May remove a build — a release, or one artifact of it. A third right, apart from uploading and
 * from moving a channel, and only the admin holds it: removal is permanent. The server refuses it
 * regardless while a channel is serving the build.
 */
export const canRemove = (me?: Me | null) => has(me, "catalog:delete");
