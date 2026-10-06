import type { components } from "@/api/schema";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import { Inspection } from "./Inspection";

type S = components["schemas"];

/**
 * The review, and the two things an operator can do with it.
 *
 * An inline panel rather than a dialog. The review is long — inspection, config
 * split by locked parameter, plugins, warnings, diff — and a modal that has to
 * scroll is a worse reading surface than the page. It also keeps this screen
 * clear of components that set inline style attributes, which the
 * Content-Security-Policy on this surface does not allow.
 */
export function CommitPanel({
  staged,
  busy,
  onCommit,
  onDiscard,
}: {
  staged: S["StagedUpload"];
  busy: boolean;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  return (
    <section className="mt-6 rounded-lg border border-line p-4">
      {/* Read from the response, never assumed. The previous UI shipped a panel
          that looked exactly like this one but came AFTER the write, and it was
          read as "done" — which is why the server says so in the payload. */}
      <h3 className="font-semibold text-ink">
        {staged.stored === false ? "Nothing stored yet" : "Stored"}
      </h3>
      <p className="mt-1 text-sm text-muted">
        {staged.version ?? "unknown version"} · {staged.system ?? "no system"} ·{" "}
        {(staged.size ?? 0).toLocaleString()} bytes
        {staged.sha256 ? <> · <span className="font-mono text-xs">{staged.sha256}</span></> : null}
      </p>

      <Inspection inspection={staged.inspection} />
      <DiffView diff={staged.diff} />

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={onCommit} disabled={busy}>
          {busy ? "Publishing…" : "Publish to beta"}
        </Button>
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Publishing puts this on <strong>beta</strong> only. An admin promotes it to{" "}
        <strong>stable</strong> separately, and that is what the fleet follows.
      </p>
    </section>
  );
}
