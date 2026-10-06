import { Button } from "@/components/ui/button";

import { describeRemoval, type RemovalTarget } from "@/lib/removal";

export type { RemovalTarget };

/**
 * The question asked before a build is removed, and the answer when it may not be.
 *
 * An INLINE panel, not a dialog: `/admin/*` is served with `style-src 'self'` and no
 * 'unsafe-inline', and the dialog primitive positions itself with inline styles.
 *
 * A build a channel is serving is never offered for removal — not because this screen decides,
 * but because the server refuses and the screen says so first. `refusal` is the server's answer,
 * taken under a lock at the moment of removal, and wins over `servedBy`, which is only as fresh
 * as the last catalog fetch. The case that separates them is a channel moved onto this release
 * after the page loaded.
 */
export function RemovePanel({
  target,
  servedBy,
  refusal,
  busy,
  onConfirm,
  onCancel,
}: {
  target: RemovalTarget;
  servedBy: string[];
  refusal: string[] | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {

  const blocking = refusal ?? (servedBy.length > 0 ? servedBy : null);
  if (blocking) {
    const release = target.version;
    return (
      <section className="mt-3 rounded-lg border border-line p-4">
        <h3 className="font-semibold text-ink">
          {target.kind === "release" ? `${release} is being served` : `${release} is being served, so its files stay`}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {refusal ? "The server refused: " : ""}
          <strong>{blocking.join(", ")}</strong> {blocking.length === 1 ? "is" : "are"} pointing at{" "}
          <span className="font-mono">{release}</span>. Removing{" "}
          {target.kind === "release" ? "it" : "a file from it"} would tell every device there that
          there is no update, with no error anywhere. Point{" "}
          {blocking.length === 1 ? "that channel" : "those channels"} at another release first.
        </p>
        <div className="mt-4">
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </section>
    );
  }

  const statement = describeRemoval(target);
  return (
    <section className="mt-3 rounded-lg border border-line p-4">
      <h3 className="font-semibold text-ink">{statement.title}</h3>
      {statement.lines.map((line) => (
        <p key={line} className="mt-1 text-sm text-muted">
          {line}
        </p>
      ))}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Removing…" : "Remove"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
