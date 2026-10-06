import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError } from "@/lib/api";
import { RELEASE_IN_USE, describeRemoval, inUse, servedBy } from "@/lib/removal";
import type { Catalog } from "@/lib/removal";

/**
 * What the Catalog screen needs to reason about removing a build — and the one thing it must
 * never do, which is decide for itself which of two versions is newer.
 */

const refusal = (details: unknown) =>
  new ApiError({
    status: 409,
    code: "invalid_parameter",
    message: "Release 1.4.0 is the latest of: gcs/stable.",
    details,
  } as never);

describe("inUse", () => {
  it("returns the release_in_use finding, with the channels serving it", () => {
    const finding = inUse(refusal([{ rule: RELEASE_IN_USE, message: "…", channels: ["gcs/stable"] }]));
    expect(finding?.rule).toBe(RELEASE_IN_USE);
    expect((finding as { channels?: string[] } | null)?.channels).toEqual(["gcs/stable"]);
  });

  it("keys on the rule, never on the message", () => {
    // Same words, another rule. The message is prose and may be reworded; the rule is contract.
    const worded = refusal([{ rule: "channel_rollback", message: "Release 1.4.0 is the latest of: gcs/stable." }]);
    expect(inUse(worded)).toBeNull();
  });

  it("is null without details, and for anything that is not an ApiError", () => {
    expect(inUse(refusal(undefined))).toBeNull();
    expect(inUse(new Error("network"))).toBeNull();
    expect(inUse(undefined)).toBeNull();
  });
});

const catalog = {
  channels: [
    { system: "gcs", name: "stable", latest: "1.4.0" },
    { system: "gcs", name: "beta", latest: "1.5.0" },
    { system: "air", name: "stable", latest: "1.4.0" },
  ],
} as Catalog;

describe("servedBy", () => {
  it("names the channels of the same system pointing at this version", () => {
    expect(servedBy(catalog, { system: "gcs", version: "1.4.0" })).toEqual(["stable"]);
  });

  it("does not reach across systems", () => {
    // air/stable serves 1.4.0 too; removing gcs's 1.4.0 has nothing to do with it.
    expect(servedBy(catalog, { system: "air", version: "1.5.0" })).toEqual([]);
    expect(servedBy(catalog, { system: "air", version: "1.4.0" })).toEqual(["stable"]);
  });

  it("is empty for an unserved release and for a catalog that has not loaded", () => {
    expect(servedBy(catalog, { system: "gcs", version: "9.9.9" })).toEqual([]);
    expect(servedBy(undefined, { system: "gcs", version: "1.4.0" })).toEqual([]);
  });
});

describe("no version comparison", () => {
  it("removal.ts looks versions up and never orders them", () => {
    const source = readFileSync(new URL("../src/lib/removal.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/localeCompare|\bisNewer\b|\bcompareVersions\b|\bparseVersion\b/);
  });
});

/**
 * What the confirmation says. The one moment an operator can catch removing the wrong build is
 * before it goes, and a confirmation that says only "are you sure" is asking about nothing.
 */
describe("describeRemoval", () => {
  const said = (d: { title: string; lines: string[] }) => [d.title, ...d.lines].join(" ");

  it("names a release's version and system, how many artifacts go with it, and that it is final", () => {
    const text = said(describeRemoval({ kind: "release", version: "7.1.0", system: "HERA", artifactCount: 2 }));
    expect(text).toContain("7.1.0");
    expect(text).toContain("HERA");
    expect(text).toMatch(/\b2 artifacts\b/);
    expect(text).toMatch(/cannot be undone/i);
  });

  it("says one artifact, not one artifacts", () => {
    const text = said(describeRemoval({ kind: "release", version: "7.1.0", system: "HERA", artifactCount: 1 }));
    expect(text).toMatch(/\b1 artifact\b(?!s)/);
  });

  it("names an artifact's file, its platforms and the release it belongs to", () => {
    const text = said(describeRemoval({
      kind: "artifact", id: 3, file: "linux-x86_64.tar.gz", platforms: ["linux-x86_64"], version: "7.1.0",
    }));
    expect(text).toContain("linux-x86_64.tar.gz");
    expect(text).toContain("linux-x86_64");
    expect(text).toContain("7.1.0");
    expect(text).toMatch(/cannot be undone/i);
  });

  it("never states nothing", () => {
    for (const target of [
      { kind: "release", version: "1.0.0", system: "", artifactCount: 0 },
      { kind: "artifact", id: 1, file: "", platforms: [], version: "1.0.0" },
    ] as const) {
      const d = describeRemoval(target);
      expect(d.title.trim()).not.toBe("");
      expect(d.lines.length).toBeGreaterThan(0);
    }
  });
});
