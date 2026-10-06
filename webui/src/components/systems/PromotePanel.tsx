import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PromoteState } from "@/lib/promote";

/**
 * The two questions asked before a channel moves.
 *
 * An INLINE panel and not a dialog. `/admin/*` is served with `style-src 'self'` and no
 * `'unsafe-inline'`, and the dialog primitive positions itself with inline styles — it would
 * render as an unstyled block over the page. That is a deployment constraint, not a taste.
 *
 * The two questions are different questions and are asked at different times:
 *
 * 1. BEFORE anything is sent — this release is currently serving another channel, and
 *    promoting it takes it off there. The server does that in the same transaction and is
 *    right to; the operator still has to know a test group is about to go empty.
 * 2. AFTER the server refuses — this is a backward move. Never predicted here: the comparison
 *    belongs to the server, and a second opinion in the browser about the one action that
 *    reaches an aircraft is one opinion too many.
 *
 * Declining either sends nothing further.
 */
export function PromotePanel({
  state,
  onConfirm,
  onDecline,
}: {
  state: PromoteState;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  if (state.phase === "idle" || state.phase === "cancelled") return null;

  if (state.phase === "done") {
    const { target, released } = state;
    return (
      <Alert variant="info" className="mt-4">
        <strong>{target.channel}</strong> now serves{" "}
        <span className="font-mono">{target.version}</span>.
        {released.length > 0 ? (
          <>
            {" "}
            {released.join(", ")} {released.length === 1 ? "is" : "are"} now serving nothing —
            one release runs on one channel at a time.
          </>
        ) : null}
      </Alert>
    );
  }

  const busy = state.phase === "sending";
  const { target } = state;

  // The second question. Reachable only because the server said so, and it names both
  // versions because a confirmation that cannot state what it is confirming is a rubber stamp.
  if (state.phase === "confirmingRollback") {
    return (
      <section className="mt-4 rounded-lg border border-line p-4">
        <h3 className="font-semibold text-ink">This would move the channel backwards</h3>
        <p className="mt-1 text-sm text-muted">
          <strong>
            {target.system}/{target.channel}
          </strong>{" "}
          is on <span className="font-mono">{state.from}</span>, and{" "}
          <span className="font-mono">{state.to}</span> is older. Nodes that already updated
          will not go back, but a device provisioned after this would take it — the fleet
          splits into "updated before" and "provisioned after".
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Sending…" : "Move it back anyway"}
          </Button>
          <Button variant="ghost" onClick={onDecline} disabled={busy}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  // The first question, asked before anything is sent.
  return (
    <section className="mt-4 rounded-lg border border-line p-4">
      <h3 className="font-semibold text-ink">
        Point {target.channel} at {target.version}?
      </h3>
      <p className="mt-1 text-sm text-muted">
        Every node following <strong>{target.channel}</strong> is offered{" "}
        <span className="font-mono">{target.version}</span> from the moment this is done. This
        is the one action here that reaches an aircraft.
      </p>

      {target.losing.length > 0 ? (
        <Alert variant="warning" className="mt-3">
          {target.losing.join(", ")} {target.losing.length === 1 ? "is" : "are"} serving{" "}
          <span className="font-mono">{target.version}</span> now and will be left serving
          nothing. One release runs on one channel at a time, so promoting it moves it rather
          than copying it — nodes there keep what they installed and are simply offered nothing
          new.
        </Alert>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? "Sending…" : `Promote to ${target.channel}`}
        </Button>
        <Button variant="ghost" onClick={onDecline} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
