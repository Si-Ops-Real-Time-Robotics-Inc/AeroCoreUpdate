import { useState } from "react";

/**
 * Sorting a table by one of its columns.
 *
 * Kept out of the components because every table needs the same three
 * decisions, and getting any of them different on one screen is what makes a
 * list feel unreliable:
 *
 *   - a second click on the same column reverses it rather than re-sorting;
 *   - a value that is missing sorts last in BOTH directions, because a blank is
 *     not "smaller than everything" — sending empties to the top of a descending
 *     sort buries the rows somebody was actually looking for;
 *   - text compares with `localeCompare` so accented names land where a reader
 *     expects rather than where their code points fall.
 */
export type SortDir = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

export function useSort<K extends string>(initial: SortState<K>) {
  const [sort, setSort] = useState<SortState<K>>(initial);

  /** Click a column: sort by it, or reverse it if it is already the one. */
  const toggle = (key: K) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return { sort, toggle };
}

type Sortable = string | number | null | undefined;

/**
 * Sort a copy of `rows` by whatever `value` returns for each.
 *
 * A copy: sorting the array a query handed back mutates the cache TanStack
 * Query is holding, and the next render reads a list somebody else already
 * reordered.
 */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K>,
  value: (row: T, key: K) => Sortable,
): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a, sort.key);
    const bv = value(b, sort.key);

    // Missing last, whichever way the column is pointing.
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sign;
  });
}

/** A date column's sort value: the instant, not the formatted string. */
export function dateValue(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}
