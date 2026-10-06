import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { straysWorthShowing } from "@/lib/channels";
import type { Catalog } from "@/lib/channels";

/**
 * The banner that is the only place a silent failure becomes visible.
 *
 * Nodes asking for a channel that does not exist get a correct 204 and no error, so they go on
 * receiving nothing while every other view reads green.
 */

const catalog = {
  stray_channels: [
    { system: "gcs", channel: "stabel", nodes: 40, last_seen: "2026-09-10T09:00:00Z" },
    { system: "air", channel: "old", nodes: 2, last_seen: "2026-09-01T09:00:00Z" },
  ],
} as Catalog;

describe("straysWorthShowing", () => {
  it("carries all four fields through, not just the names", () => {
    // A list of names cannot answer the operator's actual question: stale row, or forty
    // aircraft getting nothing since Tuesday?
    const [first] = straysWorthShowing(catalog);
    expect(first).toMatchObject({ system: "gcs", channel: "stabel", nodes: 40 });
    expect(first.last_seen).toBe("2026-09-10T09:00:00Z");
  });

  it("puts the one with the most devices first", () => {
    expect(straysWorthShowing(catalog).map((s) => s.channel)).toEqual(["stabel", "old"]);
  });

  it("renders nothing at all when there are none", () => {
    expect(straysWorthShowing({ stray_channels: [] } as Catalog)).toEqual([]);
    expect(straysWorthShowing(undefined)).toEqual([]);
  });
});

describe("the banner component", () => {
  const source = readFileSync(
    new URL("../src/components/systems/StrayBanner.tsx", import.meta.url), "utf8",
  );

  it("returns nothing when there is nothing to say", () => {
    expect(source).toMatch(/strays\.length === 0\) return null/);
  });

  it("renders the device count and the time, not only the channel names", () => {
    expect(source).toMatch(/\bnodes\b/);
    expect(source).toMatch(/last_seen/);
    // The summary states a total, so the banner answers "how bad" before it is expanded.
    expect(source).toMatch(/devices\b|\bdevice\b/);
  });
});
