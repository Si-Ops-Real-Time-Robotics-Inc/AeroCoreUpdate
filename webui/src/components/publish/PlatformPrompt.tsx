import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { androidOnly, KNOWN_PLATFORMS } from "@/lib/platforms";

/**
 * The one question a bundle cannot answer for itself.
 *
 * A bundle carrying only configuration names no target platforms, and the server
 * will not guess — guessing would file a payload against devices nobody chose.
 * So the operator is asked, and the upload is retried with the answer.
 *
 * The file is still held by the screen, so answering does not mean choosing the
 * file again.
 */
export function PlatformPrompt({
  message,
  busy,
  onRetry,
  onCancel,
}: {
  message: string;
  busy: boolean;
  onRetry: (platforms: string[]) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);

  const toggle = (platform: string) =>
    setChosen((current) =>
      current.includes(platform)
        ? current.filter((p) => p !== platform)
        : [...current, platform],
    );

  const onlyAndroid = androidOnly(chosen);

  return (
    <section className="mt-6 rounded-lg border border-line p-4">
      <h3 className="font-semibold text-ink">Which devices is this for?</h3>
      <p className="mt-1 text-sm text-muted">{message}</p>

      <fieldset className="mt-4">
        <legend className="sr-only">Target platforms</legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {KNOWN_PLATFORMS.map((platform) => (
            <label key={platform} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(platform)}
                onChange={() => toggle(platform)}
                disabled={busy}
              />
              <span className="font-mono text-xs">{platform}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {onlyAndroid ? (
        <Alert variant="warning" className="mt-3">
          Android core binaries cannot be replaced over the air, so this publishes plugins and
          configuration only.
        </Alert>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => onRetry(chosen)} disabled={busy || chosen.length === 0}>
          {busy ? "Uploading…" : "Upload for these"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
