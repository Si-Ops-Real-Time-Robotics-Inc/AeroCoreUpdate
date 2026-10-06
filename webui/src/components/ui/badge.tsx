import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The pill. This is the one place the system allows a fully rounded shape, and
 * the one place semantic colour appears — a status has to read as pass or fail
 * before it is read as a word, and the rule against a second brand colour is
 * about surfaces and CTAs rather than about legibility of state.
 *
 * `brand` is the yellow pill the document calls `badge-yellow`, uppercase and
 * reserved for emphasis. It is not a status.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 " +
    "text-caption font-medium whitespace-nowrap border",
  {
    variants: {
      variant: {
        default: "bg-elevated text-body border-hairline-strong",
        success: "bg-success-soft text-success border-transparent",
        warning: "bg-warning-soft text-warning border-transparent",
        danger: "bg-danger-soft text-danger border-transparent",
        brand:
          "bg-primary text-on-primary border-transparent " +
          "text-overline font-semibold uppercase tracking-[1.5px]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/**
 * A badge with a hint underneath — "reconnecting", then "the drone dropped".
 *
 * The pair is one cell's worth of meaning, so it is one component: putting the
 * hint in the markup beside the badge is how it ends up looking like the next
 * column's content when a table gets narrow.
 */
export function StatusCell({
  badge,
  hint,
}: {
  badge: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="inline-flex flex-col items-start gap-1">
      {badge}
      {hint && <span className="text-caption text-muted">{hint}</span>}
    </div>
  );
}

export { badgeVariants };
