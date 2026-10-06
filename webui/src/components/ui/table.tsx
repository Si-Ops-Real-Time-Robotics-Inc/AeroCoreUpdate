import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortState } from "@/lib/sort";

/**
 * A data table on a dark surface.
 *
 * The design document has no table — its Known Gaps admit the product surface
 * is out of scope — so this is built from the tokens the document does define:
 * the card surface, the hairline, the uppercase caption for column names, and
 * body text at 14px.
 *
 * Below 720px every row becomes a card and every cell carries its own column
 * name, because a nine-column table on a phone is a table nobody reads. That
 * needs `data-label` on each cell; `TableCell` takes a `label` prop so the two
 * cannot drift apart the way a hand-written attribute does.
 */
export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-hairline bg-surface max-md:border-0 max-md:bg-transparent max-md:overflow-visible">
      <table className={cn("w-full caption-bottom text-body max-md:block", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("max-md:hidden", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("max-md:block", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-hairline transition-colors last:border-0",
        "hover:bg-elevated focus-within:bg-elevated",
        // As a card, on a phone.
        "max-md:mb-3 max-md:block max-md:rounded-lg max-md:border max-md:bg-surface max-md:px-4",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-4 pb-2 pt-3 text-left align-middle whitespace-nowrap",
        "text-overline font-semibold uppercase tracking-[1.5px] text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  label,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { label?: string }) {
  return (
    <td
      data-label={label}
      className={cn(
        "px-4 py-3 align-top text-body",
        // On a phone: the column name returns beside its value, from data-label.
        "max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4",
        "max-md:border-t max-md:border-hairline max-md:px-0 max-md:text-right",
        "max-md:first:border-t-0 max-md:first:font-semibold",
        "max-md:before:content-[attr(data-label)] max-md:before:text-caption",
        "max-md:before:text-muted max-md:before:text-left max-md:before:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/** A list with nothing in it is a state, not a gap in the page. */
export function TableEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-hairline-strong bg-surface/40 px-6 py-10 text-center text-body text-muted">
      {children}
    </div>
  );
}

/**
 * A column header you can sort by.
 *
 * A real `<button>` inside the `<th>` rather than a click handler on the cell:
 * a header that reorders a table is an action, and making it one means it is
 * reachable by keyboard and announced as a button without any aria of its own.
 *
 * `aria-sort` is on the header itself, which is where a screen reader looks —
 * so the current column and direction are spoken rather than left to the arrow.
 */
export function SortableHead<K extends string>({
  column,
  sort,
  onSort,
  align = "left",
  children,
}: {
  column: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = sort.key === column;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "text-right" : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5",
          "text-overline font-semibold uppercase tracking-[1.5px]",
          "transition-colors hover:text-ink",
          active ? "text-ink" : "text-muted",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        {/* The idle state shows a faint two-way chevron rather than nothing, so
            it is discoverable that the column sorts at all. */}
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ChevronsUpDown className="size-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
