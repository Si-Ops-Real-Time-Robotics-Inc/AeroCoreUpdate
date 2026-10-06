import { describe, expect, it } from "vitest";
import { channelsFor, channelsLosing, straysWorthShowing } from "@/lib/channels";
import type { Catalog } from "@/lib/channels";

const catalog = {
  channels: [
    { system: "gcs", name: "beta", latest: "1.4.0" },
    { system: "gcs", name: "stable", latest: "1.3.0" },
    { system: "gcs", name: "canary", latest: "1.4.0" },
    { system: "air", name: "beta", latest: "1.4.0" },
  ],
} as Catalog;

const target = { system: "gcs", channel: "stable" };

describe("channelsLosing", () => {
  it("names the channels that would stop serving this version", () => {
    // Promoting 1.4.0 to stable takes it off both channels currently serving it — invisible
    // otherwise, and a test group that quietly goes empty is one nobody notices is empty.
    expect(channelsLosing(catalog, "1.4.0", target).sort()).toEqual(["beta", "canary"]);
  });

  it("is empty when the version sits on no other channel", () => {
    expect(channelsLosing(catalog, "9.9.9", target)).toEqual([]);
  });

  it("never counts the target itself — it is gaining, not losing", () => {
    // Otherwise the screen says promoting to stable clears stable.
    expect(channelsLosing(catalog, "1.3.0", target)).toEqual([]);
  });

  it("does not reach across systems", () => {
    // air/beta serves 1.4.0 too, and promoting on gcs does nothing to it.
    expect(channelsLosing(catalog, "1.4.0", target)).not.toContain("air");
    expect(channelsLosing(catalog, "1.4.0", { system: "air", channel: "stable" }))
      .toEqual(["beta"]);
  });

  it("survives a catalog that has not loaded", () => {
    expect(channelsLosing(undefined, "1.4.0", target)).toEqual([]);
  });
});

describe("channelsFor", () => {
  it("returns one system's channels in a stable order", () => {
    expect(channelsFor(catalog, "gcs").map((c) => c.name)).toEqual(["beta", "canary", "stable"]);
  });
});

describe("straysWorthShowing", () => {
  it("puts the channel the most nodes are asking for first", () => {
    const strays = straysWorthShowing({
      stray_channels: [
        { system: "gcs", channel: "old", nodes: 1, last_seen: "2026-09-01T00:00:00Z" },
        { system: "gcs", channel: "typo", nodes: 40, last_seen: "2026-09-10T00:00:00Z" },
      ],
    } as Catalog);

    expect(strays.map((s) => s.channel)).toEqual(["typo", "old"]);
    // All four fields survive: a banner that lists only names cannot tell an operator whether
    // this is a stale row or an incident happening now.
    expect(strays[0]).toMatchObject({ system: "gcs", channel: "typo", nodes: 40 });
    expect(strays[0].last_seen).toBe("2026-09-10T00:00:00Z");
  });

  it("survives a catalog with none", () => {
    expect(straysWorthShowing({} as Catalog)).toEqual([]);
  });
});
