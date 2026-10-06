import { describe, expect, it } from "vitest";
import { isConfigFile, splitLocked, systemScope } from "@/lib/inspection";

/**
 * These mirror the readings the node itself makes. A screen that disagrees with
 * the node is worse than an ugly one: it describes an install that will not
 * happen.
 */
describe("systemScope", () => {
  it("reads no declared system as 'any', the way the node does", () => {
    expect(systemScope([], "HERA")).toEqual({ kind: "any" });
    expect(systemScope(undefined, "HERA")).toEqual({ kind: "any" });
    expect(systemScope(null, null)).toEqual({ kind: "any" });
  });

  it("names the other products a plugin is shared with", () => {
    expect(systemScope(["HERA", "ATLAS"], "HERA")).toEqual({ kind: "shared", others: ["ATLAS"] });
  });

  it("says nothing when a plugin is built only for this bundle", () => {
    expect(systemScope(["HERA"], "HERA")).toEqual({ kind: "only-this" });
  });

  it("flags a plugin that does not cover this bundle — the node will skip it", () => {
    expect(systemScope(["ATLAS"], "HERA")).toEqual({
      kind: "not-covered",
      systems: ["ATLAS"],
      bundleSystem: "HERA",
    });
  });

  it("treats case as significant, because the node does", () => {
    // `hera` does not cover a bundle stamped `HERA`. Folding case here would
    // hide a plugin that silently never installs.
    expect(systemScope(["hera"], "HERA").kind).toBe("not-covered");
  });

  it("has nothing to compare against when the bundle names no system", () => {
    expect(systemScope(["HERA"], null)).toEqual({ kind: "declared", systems: ["HERA"] });
    expect(systemScope(["HERA"], "")).toEqual({ kind: "declared", systems: ["HERA"] });
  });
});

describe("splitLocked", () => {
  const params = [
    { param: "update.enabled", value: true, locked: false, readonly: false },
    { param: "update.server_url", value: "https://x", locked: true, readonly: false },
    { param: "log.level", value: "info", locked: false, readonly: true },
  ];

  it("keeps what will apply apart from what will not", () => {
    const { applied, locked } = splitLocked(params);
    expect(applied.map((p) => p.param)).toEqual(["update.enabled", "log.level"]);
    expect(locked.map((p) => p.param)).toEqual(["update.server_url"]);
  });

  it("does not confuse readonly with locked", () => {
    // readonly describes the parameter; locked describes the device's choice.
    // Only the second decides whether the value is applied.
    expect(splitLocked(params).applied.some((p) => p.param === "log.level")).toBe(true);
  });

  it("survives a file with no params at all", () => {
    expect(splitLocked(undefined)).toEqual({ applied: [], locked: [] });
    expect(splitLocked([])).toEqual({ applied: [], locked: [] });
  });
});

describe("isConfigFile", () => {
  it("reports a file with no params as shipped but not configuration", () => {
    // ota_keys.json, for instance: still replaces whatever the node has.
    expect(isConfigFile({ file: "ota_keys.json", plugin: null, params: [] })).toBe(false);
    expect(isConfigFile({ file: "core.json", plugin: null, params: [{ param: "a.b", value: 1, locked: false, readonly: false }] })).toBe(true);
  });

});
