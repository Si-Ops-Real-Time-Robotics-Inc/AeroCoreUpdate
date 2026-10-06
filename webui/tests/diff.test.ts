import { describe, expect, it } from "vitest";
import { moved, summarise } from "@/lib/diff";

const base = { previousVersion: "1.0.0", isFirst: false, platforms: {}, cores: [], plugins: [], config: [], no_op: false };

describe("summarise", () => {
  it("separates being first from changing nothing", () => {
    // Two situations an operator must not confuse: nothing to compare against,
    // versus a comparison that came back empty.
    expect(summarise({ ...base, isFirst: true, previousVersion: null }).kind).toBe("first");
    expect(summarise({ ...base, no_op: true }).kind).toBe("no-op");
  });

  it("reports an unusable baseline as its own outcome", () => {
    expect(summarise({ ...base, noComparable: true })).toEqual({
      kind: "no-comparable",
      previousVersion: "1.0.0",
    });
  });

  it("returns nothing when there is no diff at all", () => {
    expect(summarise(null)).toBeNull();
    expect(summarise(undefined)).toBeNull();
  });

  it("drops unchanged rows, which are noise on a review screen", () => {
    const summary = summarise({
      ...base,
      plugins: [
        { platform: "linux-x64", name: "a", change: "unchanged", from: "1", to: "1" },
        { platform: "linux-x64", name: "b", change: "changed", from: "1", to: "2" },
      ],
      config: [{ platform: "linux-x64", target: "core", param: "x.y", change: "unchanged", from: 1, to: 1 }],
    });
    expect(summary).toMatchObject({ kind: "changes" });
    if (summary?.kind !== "changes") throw new Error("unreachable");
    expect(summary.plugins.map((p) => p.name)).toEqual(["b"]);
    expect(summary.config).toEqual([]);
  });

  it("survives a diff arriving without its optional keys", () => {
    const summary = summarise({ isFirst: false, no_op: false } as never);
    expect(summary).toEqual({
      kind: "changes",
      previousVersion: null,
      platformsAdded: [],
      platformsRemoved: [],
      cores: [],
      plugins: [],
      config: [],
    });
  });
});

describe("moved", () => {
  it("keeps every change that is not 'unchanged'", () => {
    expect(moved([{ change: "added" }, { change: "unchanged" }, { change: "removed" }])).toHaveLength(2);
    expect(moved(null)).toEqual([]);
  });
});
