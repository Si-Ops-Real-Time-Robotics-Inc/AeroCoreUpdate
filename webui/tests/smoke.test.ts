import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

/**
 * Guards the runner itself. Three of the assertions in this repository have
 * already passed vacuously — a regex that matched nothing, a suite that never
 * imported the code under test — so the first test here proves the harness can
 * reach the source at all.
 */
describe("test harness", () => {
  it("resolves the @ alias into src/", () => {
    expect(typeof cn).toBe("function");
    expect(cn("a", "b")).toContain("a");
  });
});
