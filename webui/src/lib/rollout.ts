import type { components } from "@/api/schema";

type S = components["schemas"];
export type RolloutStat = S["RolloutStat"];
export type NodeReport = S["NodeReport"];

/**
 * What the fleet said happened.
 *
 * The distinction this file exists for is SILENCE versus SUCCESS. A release nobody reported on
 * and a release everybody installed cleanly both produce zero failures, and rendering them the
 * same way is how a rollout that never left the ground reads as a rollout that went perfectly.
 * They are separate states here so a screen cannot accidentally collapse them.
 */

export type RolloutSummary =
  | { kind: "silent"; total: 0 }
  | { kind: "reported"; total: number; succeeded: number; failed: number; groups: RolloutStat[] };

const SUCCESS = "success";

/** `(none)` is the server's placeholder, so a group is never keyed on an empty string. */
export const NO_ERROR = "(none)";

export function summarise(stats: RolloutStat[] | undefined): RolloutSummary {
  const groups = (stats ?? []).filter((s) => typeof s.count === "number" && s.count > 0);
  const total = groups.reduce((sum, s) => sum + (s.count ?? 0), 0);

  // Not "no failures". No reports at all — the fleet has said nothing, which is a thing an
  // operator must be told rather than left to infer from an empty table.
  if (total === 0) return { kind: "silent", total: 0 };

  const succeeded = groups
    .filter((s) => s.result === SUCCESS)
    .reduce((sum, s) => sum + (s.count ?? 0), 0);

  return {
    kind: "reported",
    total,
    succeeded,
    failed: total - succeeded,
    // Most common first, and failures ahead of successes at equal counts: the reason to open
    // this screen is almost always to find out what went wrong.
    groups: [...groups].sort((a, b) => {
      const byCount = (b.count ?? 0) - (a.count ?? 0);
      if (byCount !== 0) return byCount;
      const aOk = a.result === SUCCESS ? 1 : 0;
      const bOk = b.result === SUCCESS ? 1 : 0;
      return aOk - bOk;
    }),
  };
}

export function isFailure(stat: RolloutStat): boolean {
  // Anything other than success counts against the release. Listing the failure results
  // instead would silently pass any new one the node learns to send.
  return stat.result !== SUCCESS;
}

/** The error text for display, or null when the node reported none. */
export function errorText(stat: RolloutStat | NodeReport): string | null {
  const value = stat.error;
  if (!value || value === NO_ERROR) return null;
  return value;
}

/**
 * When this row happened, preferring the server's own clock.
 *
 * `at` is what the node says and node clocks are not trustworthy — a device with a dead RTC
 * reports 1970 and would sort to the bottom of a list an operator is reading top-down.
 */
export function reportedAt(report: NodeReport): string {
  return report.received_at ?? report.at ?? "";
}
