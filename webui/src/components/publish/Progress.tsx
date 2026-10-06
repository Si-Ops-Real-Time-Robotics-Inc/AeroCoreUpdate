import { progressPercent } from "@/lib/upload";

/**
 * Transfer progress.
 *
 * A native `<progress>` rather than a div whose width is set inline: the
 * Content-Security-Policy on this surface is `style-src 'self'` with no
 * `'unsafe-inline'`, and a bar that depends on an inline style is a bar that
 * may or may not move depending on how the framework happens to apply it. The
 * native element also announces itself to a screen reader for free.
 *
 * The percentage is derived here on every render and never stored, so the bar
 * and its caption cannot drift apart.
 */
export function Progress({
  phase,
  loaded,
  total,
}: {
  phase: string;
  loaded: number;
  total: number;
}) {
  const known = total > 0;
  const percent = progressPercent(loaded, total);

  return (
    <div className="my-4">
      <progress
        className="w-full"
        value={known ? loaded : undefined}
        max={known ? total : undefined}
        aria-label={phase}
      />
      <p className="mt-1 text-sm text-muted">
        {known
          ? `${phase} — ${percent}% (${loaded.toLocaleString()} / ${total.toLocaleString()} bytes)`
          : `${phase} — ${loaded.toLocaleString()} bytes sent`}
      </p>
    </div>
  );
}
