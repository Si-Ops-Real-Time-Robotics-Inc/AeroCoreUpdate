import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Channel } from "@/lib/channels";

/**
 * What removing a system takes with it.
 *
 * A system is a version line, not a pointer: the releases filed under it and the channels
 * serving them belong to it. Deleting one is not undone by creating it again with the same
 * name, so the question has to state what is attached before it is answered — a confirmation
 * that only says "are you sure" is asking about nothing.
 */
export function DeleteSystemPanel({
  system,
  channels,
  releaseCount,
  busy,
  onConfirm,
  onCancel,
}: {
  system: string;
  channels: Channel[];
  releaseCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const serving = channels.filter((c) => c.latest);

  return (
    <section className="mt-4 rounded-lg border border-line p-4">
      <h3 className="font-semibold text-ink">Remove {system}?</h3>

      <p className="mt-1 text-sm text-muted">
        {releaseCount === 0
          ? "No releases are filed under this system."
          : `${releaseCount} release${releaseCount === 1 ? " is" : "s are"} filed under this system.`}{" "}
        {channels.length === 0
          ? "It defines no channels."
          : `It defines ${channels.length} channel${channels.length === 1 ? "" : "s"}: ${channels
              .map((c) => c.name)
              .join(", ")}.`}
      </p>

      {serving.length > 0 ? (
        <Alert variant="warning" className="mt-3">
          {serving.map((c) => `${c.name} → ${c.latest}`).join(", ")}. Nodes following{" "}
          {serving.length === 1 ? "it" : "them"} are being offered {serving.length === 1 ? "that build" : "those builds"} right now.
        </Alert>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Removing…" : `Remove ${system}`}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
