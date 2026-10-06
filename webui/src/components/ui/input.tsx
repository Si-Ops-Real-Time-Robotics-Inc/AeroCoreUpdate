import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The document's `text-input`: 40px tall, 8px radius, card surface, 10×14
 * padding — and on focus the border thickens to the brand yellow, which is the
 * one state it specifies.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-md border border-hairline bg-surface px-3.5 py-2.5",
        "text-body text-ink outline-none transition-colors",
        "focus-visible:border-primary focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("block text-caption font-medium text-muted", className)}
      {...props}
    />
  );
}

/** A field and its label, so the two are never spaced differently twice. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-caption font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-caption text-muted">{hint}</span>}
    </label>
  );
}
