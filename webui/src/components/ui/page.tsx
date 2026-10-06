import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The shell every screen sits in.
 *
 * The document's 96px section rhythm is a marketing measure — it exists to let
 * one idea land per scroll. A screen whose job is to answer "is everything
 * flying" wants the answer above the fold, so bands here are 32px apart and the
 * container is the document's 1280px.
 */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-8 max-md:px-4">{children}</div>;
}

export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-display font-bold text-ink">{title}</h1>
        {/* Held to a readable measure: a line running the full 1280px is one the
            eye loses its place in on the way back. */}
        {lede && <p className="mt-2 max-w-[68ch] text-body text-muted">{lede}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  trailing,
  children,
  className,
}: {
  title?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8", className)}>
      {title && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-title-md font-semibold text-ink">{title}</h2>
          {trailing}
        </div>
      )}
      {children}
    </section>
  );
}

/** Tiles across the top: one figure each, wrapping rather than shrinking. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}
