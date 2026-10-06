import type { components } from "@/api/schema";

type S = components["schemas"];
export type Diff = S["Diff"];

/**
 * Reading a diff, kept out of the component so the four outcomes can be tested.
 *
 * They are genuinely four, and collapsing any two loses something an operator
 * needs: being FIRST is not the same as changing NOTHING, and having no
 * comparable baseline is not the same as either.
 */
export type DiffSummary =
  | { kind: "first" }
  | { kind: "no-comparable"; previousVersion: string | null }
  | { kind: "no-op"; previousVersion: string | null }
  | {
      kind: "changes";
      previousVersion: string | null;
      platformsAdded: string[];
      platformsRemoved: string[];
      cores: NonNullable<Diff["cores"]>;
      plugins: NonNullable<Diff["plugins"]>;
      config: NonNullable<Diff["config"]>;
    };

/** Rows that actually moved. `unchanged` rows are carried for completeness and
 *  are noise on a review screen. */
export function moved<T extends { change?: string }>(rows?: readonly T[] | null): T[] {
  return (rows ?? []).filter((row) => row.change !== "unchanged");
}

export function summarise(diff: Diff | null | undefined): DiffSummary | null {
  if (!diff) return null;
  if (diff.isFirst) return { kind: "first" };
  if (diff.noComparable) {
    return { kind: "no-comparable", previousVersion: diff.previousVersion ?? null };
  }
  if (diff.no_op) return { kind: "no-op", previousVersion: diff.previousVersion ?? null };

  return {
    kind: "changes",
    previousVersion: diff.previousVersion ?? null,
    platformsAdded: diff.platforms?.added ?? [],
    platformsRemoved: diff.platforms?.removed ?? [],
    cores: moved(diff.cores),
    plugins: moved(diff.plugins),
    config: moved(diff.config),
  };
}
