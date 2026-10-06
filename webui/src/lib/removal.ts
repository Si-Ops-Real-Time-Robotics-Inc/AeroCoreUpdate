import { ApiError } from "@/lib/api";
import type { components } from "@/api/schema";

type S = components["schemas"];
export type Finding = S["Finding"];
export type Catalog = S["Catalog"];
type Release = NonNullable<Catalog["releases"]>[number];

/**
 * Removing a build, as the Catalog screen needs to reason about it.
 *
 * NOTHING HERE COMPARES VERSIONS. Whether a release may be removed is a question of fact —
 * does any channel's `latest` equal this version — and the server answers it again, under a
 * lock, at the moment of removal. This file reads what the catalog already says, so the screen
 * can explain before it is asked, and reads the server's refusal, so it can explain after.
 */

export const RELEASE_IN_USE = "release_in_use";

/**
 * The refusal that says a channel is serving this build, or null.
 *
 * Keyed on `rule`, never on the message: the message is prose for a person and may be
 * reworded, while the rule is part of the contract.
 */
export function inUse(error: unknown): Finding | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.problem.details;
  if (!Array.isArray(details)) return null;
  return (details as Finding[]).find((f) => f.rule === RELEASE_IN_USE) ?? null;
}

/**
 * The channels serving this release right now, by name.
 *
 * Read from the catalog's own channel list — the same fact the server's rule reads. The catalog
 * used to promise a per-release `channels` field that it never sent, which is how every release
 * came to read "staged".
 */
export function servedBy(
  catalog: Pick<Catalog, "channels"> | undefined,
  release: Pick<Release, "version" | "system">,
): string[] {
  return (catalog?.channels ?? [])
    .filter((c) => c.system === release.system && c.latest === release.version)
    .map((c) => c.name ?? "")
    .filter(Boolean);
}

/** What the operator is being asked to remove. */
export type RemovalTarget =
  | { kind: "release"; version: string; system: string; artifactCount: number }
  | { kind: "artifact"; id: number; file: string; platforms: string[]; version: string };

export interface RemovalStatement {
  title: string;
  lines: string[];
}

/**
 * What the confirmation says, as data.
 *
 * Pure so the wording is tested rather than eyeballed. Removal is permanent — the rows go and so
 * do the files — and the one moment an operator can catch removing the wrong build is before it
 * happens, which only works if the question names the build.
 */
export function describeRemoval(target: RemovalTarget): RemovalStatement {
  if (target.kind === "release") {
    const n = target.artifactCount;
    return {
      title: `Remove release ${target.version} of ${target.system || "an unnamed system"}?`,
      lines: [
        n === 0
          ? "It has no artifacts."
          : `Its ${n} artifact${n === 1 ? "" : "s"} and ${n === 1 ? "its file go" : "their files go"} with it.`,
        "This cannot be undone.",
      ],
    };
  }

  const where = target.platforms.length ? target.platforms.join(", ") : "no named platform";
  return {
    title: `Remove ${target.file || "this artifact"} from release ${target.version}?`,
    lines: [
      `It is what ${target.version} serves for ${where}. The rest of the release stays.`,
      "The file is deleted with it. This cannot be undone.",
    ],
  };
}
