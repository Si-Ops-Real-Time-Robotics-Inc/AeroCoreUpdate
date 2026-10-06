import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A message the page needs to make, in the voice the situation deserves.
 *
 * The left rule rather than a filled panel: a full danger-coloured block for
 * "that code has expired" shouts at somebody who mistyped one character, and a
 * screen that shouts at small problems has nothing left for real ones.
 */
const alertVariants = cva(
  "rounded-md border-l-2 px-4 py-3 text-body",
  {
    variants: {
      variant: {
        info: "border-l-hairline-strong bg-surface text-body",
        danger: "border-l-danger bg-danger-soft text-danger",
        warning: "border-l-warning bg-warning-soft text-warning",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="status" className={cn(alertVariants({ variant }), className)} {...props} />;
}
