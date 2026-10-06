import type { components } from "@/api/schema";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { isConfigFile, splitLocked, systemScope } from "@/lib/inspection";

type S = components["schemas"];

/** What a plugin's declared systems mean here, in one short phrase. */
function Scope({ systems, bundleSystem }: { systems?: string[]; bundleSystem?: string | null }) {
  const scope = systemScope(systems, bundleSystem);
  switch (scope.kind) {
    case "any":
      return <span className="text-muted" title="Declares no system, so it installs on every product.">any</span>;
    case "declared":
      return <span>{scope.systems.join(", ")}</span>;
    case "not-covered":
      // The one that matters: the node will skip this plugin entirely.
      return (
        <Badge variant="warning" title={`Does not cover ${scope.bundleSystem}. The node will skip this plugin.`}>
          {scope.systems.join(", ")}
        </Badge>
      );
    case "only-this":
      return <span className="text-muted">—</span>;
    case "shared":
      return (
        <Badge title={`Also built for ${scope.others.join(", ")}, and shipped again in those bundles.`}>
          + {scope.others.join(", ")}
        </Badge>
      );
  }
}

/** One shipped file, with the parameters that will apply kept apart from those that will not. */
function ConfigFile({ file }: { file: S["ShippedConfigFile"] }) {
  const { applied, locked } = splitLocked(file.params);

  return (
    <div className="mt-2 rounded border border-line p-2 text-sm">
      <p className="font-mono text-xs text-muted">
        {file.file}
        {file.plugin ? ` (plugin ${file.plugin})` : ""}
      </p>

      {!isConfigFile(file) ? (
        <p className="mt-1 text-muted">
          No parameters — shipped as-is, and it still replaces whatever the node has.
        </p>
      ) : null}

      {applied.length > 0 ? (
        <ul className="mt-1">
          {applied.map((p) => (
            <li key={p.param} className="font-mono text-xs">
              {p.param} = {JSON.stringify(p.value)}
            </li>
          ))}
        </ul>
      ) : null}

      {locked.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-medium text-muted">
            Locked on the device — sent, but NOT applied:
          </p>
          <ul>
            {locked.map((p) => (
              <li key={p.param} className="font-mono text-xs text-muted line-through">
                {p.param} = {JSON.stringify(p.value)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the server found inside the bundle.
 *
 * Read before anything is stored, so every section here is something an operator
 * is expected to act on rather than skim.
 */
export function Inspection({ inspection }: { inspection?: S["Inspection"] | null }) {
  if (!inspection) return null;
  const bundleSystem = inspection.release?.system ?? null;

  return (
    <section className="mt-4">
      <h4 className="font-medium text-ink">Inside the bundle</h4>
      <p className="mt-1 text-sm text-muted">
        format {inspection.format ?? "—"} · version {inspection.version ?? "—"} ·{" "}
        {(inspection.platforms ?? []).join(", ") || "no platforms"}
      </p>

      {(inspection.warnings ?? []).length > 0 ? (
        <Alert variant="warning" className="mt-3">
          <ul>
            {inspection.warnings!.map((w) => (
              <li key={`${w.rule}:${w.message}`}>
                <span className="font-mono text-xs">{w.rule}</span> — {w.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {(inspection.cores ?? []).map((core) => (
        <div key={`${core.platform}:${core.path}`} className="mt-3">
          <p className="text-sm text-ink">
            core <span className="font-mono">{core.platform}</span> · {core.slice_version ?? "—"}
            {core.system ? ` · stamped ${core.system}` : ""}
          </p>

          {/* Plugins riding inside the core slice are named, not filed under it:
              which product each covers is a different question from where it sits. */}
          {(core.bundled_plugins ?? []).map((p) => (
            <p key={p.name} className="ml-4 text-sm">
              plugin <span className="font-mono">{p.name}</span>{" "}
              {p.version_known ? p.version : <span className="text-muted">version unknown</span>}{" "}
              <Scope systems={p.systems} bundleSystem={bundleSystem} />
            </p>
          ))}

          {(core.shipped_config ?? []).map((file) => (
            <ConfigFile key={file.file} file={file} />
          ))}
        </div>
      ))}

      {(inspection.plugins ?? []).map((plugin) => (
        <div key={`${plugin.platform}:${plugin.name}`} className="mt-3">
          <p className="text-sm text-ink">
            plugin <span className="font-mono">{plugin.name}</span> ·{" "}
            {plugin.version_known ? plugin.version : "version unknown"} ·{" "}
            <Scope systems={plugin.systems} bundleSystem={bundleSystem} />
          </p>
          {(plugin.shipped_config ?? []).map((file) => (
            <ConfigFile key={file.file} file={file} />
          ))}
        </div>
      ))}

      {(inspection.configs ?? []).length > 0 ? (
        <div className="mt-3">
          <p className="text-sm text-ink">Loose configuration</p>
          {inspection.configs!.map((file) => <ConfigFile key={file.file} file={file} />)}
        </div>
      ) : null}
    </section>
  );
}
