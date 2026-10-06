import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The dark surface panel. No shadow anywhere in this system — depth is the
 * contrast between canvas and a barely-lighter surface, which the document
 * describes as an "engineering-grade dim panel" rather than an elevated card.
 *
 * Padding is 24px, not the document's 32px. Thirty-two is right for a marketing
 * feature card carrying one sentence; on a panel holding six fields it pushes
 * the content apart until the panel stops reading as one thing.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-hairline bg-surface", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-6 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-title-sm font-semibold text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-caption text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-3 p-6 pt-0", className)} {...props} />;
}

/**
 * A figure and what it means. The document's `stat-callout` is yellow text at
 * 56px on bare canvas; at dashboard scale it is 28px, and the yellow is kept for
 * the number a person came to the page to read rather than spent on all of them.
 */
export function Stat({
  label,
  value,
  hint,
  accent = false,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <Card className={cn("p-6", className)}>
      <div className="text-overline font-semibold uppercase text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 text-stat font-bold tabular-nums",
          accent ? "text-primary" : "text-ink",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-caption text-muted">{hint}</div>}
    </Card>
  );
}
