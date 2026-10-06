import type { components } from "@/api/schema";
import { Alert } from "@/components/ui/alert";
import { summarise } from "@/lib/diff";

type S = components["schemas"];

/**
 * What changes against the release below this one.
 *
 * The `no_op` case is a sentence, not an empty table. Nothing else in the system
 * answers "what am I actually shipping?" — the node reports per-component skips
 * with no top-level error, so a release that changes nothing looks exactly like
 * one that changes everything, and an empty list reads as a page that failed to
 * load rather than as an answer.
 */
export function DiffView({ diff }: { diff?: S["Diff"] | null }) {
  const summary = summarise(diff);
  if (!summary) return null;

  if (summary.kind === "first") {
    return (
      <Alert variant="info" className="mt-4">
        First release for this system — there is nothing below it to compare against.
      </Alert>
    );
  }

  if (summary.kind === "no-comparable") {
    return (
      <Alert variant="warning" className="mt-4">
        The release below ({summary.previousVersion}) carries nothing comparable, so no change
        summary can be produced.
      </Alert>
    );
  }

  if (summary.kind === "no-op") {
    return (
      <Alert variant="warning" className="mt-4">
        This release changes nothing against {summary.previousVersion}. Every device that applies
        it will end up exactly where it already is — and will report success.
      </Alert>
    );
  }

  const { cores, plugins, config, platformsAdded: added, platformsRemoved: removed } = summary;

  return (
    <section className="mt-4">
      <h4 className="font-medium text-ink">Changes against {summary.previousVersion}</h4>

      {added.length > 0 || removed.length > 0 ? (
        <p className="mt-1 text-sm">
          {added.length > 0 ? <>platforms added: {added.join(", ")}. </> : null}
          {removed.length > 0 ? (
            <span className="text-muted">platforms no longer covered: {removed.join(", ")}.</span>
          ) : null}
        </p>
      ) : null}

      {cores.length > 0 ? (
        <ul className="mt-2 text-sm">
          {cores.map((c) => (
            <li key={c.platform} className="font-mono text-xs">
              core {c.platform}: {c.from ?? "—"} → {c.to}
            </li>
          ))}
        </ul>
      ) : null}

      {plugins.length > 0 ? (
        <ul className="mt-2 text-sm">
          {plugins.map((p) => (
            <li key={`${p.platform}:${p.name}`} className="font-mono text-xs">
              plugin {p.name} ({p.platform}) {p.change}: {p.from ?? "—"} → {p.to ?? "—"}
            </li>
          ))}
        </ul>
      ) : null}

      {config.length > 0 ? (
        <ul className="mt-2 text-sm">
          {config.map((c) => (
            <li key={`${c.platform}:${c.target}:${c.param}`} className="font-mono text-xs">
              {c.target}.{c.param} {c.change}: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
