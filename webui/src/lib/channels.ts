import type { components } from "@/api/schema";

type S = components["schemas"];
export type Channel = S["Channel"];
export type Catalog = S["Catalog"];
export type StrayChannel = NonNullable<Catalog["stray_channels"]>[number];

/**
 * Which channels would stop serving this version if it were promoted.
 *
 * One release runs on one channel at a time: the server moves it, clearing whichever channel
 * was serving it in the same transaction. That is correct and it is also invisible — an
 * operator promoting `1.4.0` to `stable` has no way to know from the screen that `beta` will
 * stop serving anything at all, and a test group that quietly goes empty is a test group
 * nobody notices is empty.
 *
 * A LOOKUP, not a comparison. This reads which channels currently point at this exact version;
 * it never asks whether one version is newer than another. That question belongs to the server
 * and is answered by its refusal.
 */
export function channelsLosing(
  catalog: Pick<Catalog, "channels"> | undefined,
  version: string,
  target: { system: string; channel: string },
): string[] {
  return (catalog?.channels ?? [])
    .filter((c) => c.system === target.system)
    // The channel being promoted TO is not losing anything — it is gaining. Counting it would
    // tell an operator that promoting to stable clears stable.
    .filter((c) => c.name !== target.channel)
    .filter((c) => c.latest === version)
    .map((c) => c.name ?? "")
    .filter(Boolean);
}

/** The channels defined for one system, in a stable order for display. */
export function channelsFor(catalog: Pick<Catalog, "channels"> | undefined, system: string): Channel[] {
  return (catalog?.channels ?? [])
    .filter((c) => c.system === system)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * A channel defined for no system, that nodes are nevertheless asking for.
 *
 * They get a correct 204 and no error, so this is the only place the misconfiguration is ever
 * visible. `nodes` and `last_seen` are the difference between a stale row and an incident
 * happening right now, which is why a banner that lists only names is not enough.
 */
export function straysWorthShowing(catalog: Pick<Catalog, "stray_channels"> | undefined): StrayChannel[] {
  return [...(catalog?.stray_channels ?? [])].sort(
    (a, b) => (b.nodes ?? 0) - (a.nodes ?? 0),
  );
}
