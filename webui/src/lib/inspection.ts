import type { components } from "@/api/schema";

type S = components["schemas"];
export type ConfigParam = S["ConfigParam"];
export type ShippedConfigFile = S["ShippedConfigFile"];

/**
 * The reading decisions behind the inspection panel, kept out of the components
 * so they can be tested without a DOM — and because each one is a judgement the
 * node makes too, which is why getting them wrong is worse than an ugly table.
 */

export type SystemScope =
  /** Declares nothing, so it installs on every product — the node's own reading. */
  | { kind: "any" }
  /** Declares systems, but this bundle names none to compare against. */
  | { kind: "declared"; systems: string[] }
  /** Declares systems and this bundle's is NOT among them: the node will skip it. */
  | { kind: "not-covered"; systems: string[]; bundleSystem: string }
  /** Built only for this bundle's system. Nothing worth saying. */
  | { kind: "only-this" }
  /** Also built for other products, and shipped again in those bundles. */
  | { kind: "shared"; others: string[] };

/**
 * Which products a plugin declares it runs on.
 *
 * Printing the raw list on every row is noise on a fleet with one system, so
 * this says something only when there is something to say. The comparison is
 * case-SENSITIVE on purpose: the node compares the same way, so a plugin
 * declaring `hera` does not cover a bundle stamped `HERA`, and a screen that
 * hid that difference would hide a plugin silently not installing.
 */
export function systemScope(
  systems: readonly string[] | null | undefined,
  bundleSystem: string | null | undefined,
): SystemScope {
  const declared = [...(systems ?? [])];

  if (declared.length === 0) return { kind: "any" };
  if (!bundleSystem) return { kind: "declared", systems: declared };
  if (!declared.includes(bundleSystem)) {
    return { kind: "not-covered", systems: declared, bundleSystem };
  }

  const others = declared.filter((name) => name !== bundleSystem);
  return others.length === 0 ? { kind: "only-this" } : { kind: "shared", others };
}

/**
 * Config parameters split by whether the device has locked them.
 *
 * A locked parameter keeps the node's own value and is NOT applied, so the two
 * halves of a payload have opposite effects on a device. Showing them in one
 * list is how an operator reads a change that will never happen as one that
 * will.
 */
export function splitLocked(params: readonly ConfigParam[] | null | undefined): {
  applied: ConfigParam[];
  locked: ConfigParam[];
} {
  const all = params ?? [];
  return {
    applied: all.filter((p) => !p.locked),
    locked: all.filter((p) => Boolean(p.locked)),
  };
}

/**
 * Whether a shipped file is a config file at all.
 *
 * A file with no params — `ota_keys.json`, say — is still shipped and still
 * replaces whatever the node has, so it is reported rather than dropped. It just
 * has nothing to split.
 */
export function isConfigFile(file: ShippedConfigFile): boolean {
  return (file.params?.length ?? 0) > 0;
}
