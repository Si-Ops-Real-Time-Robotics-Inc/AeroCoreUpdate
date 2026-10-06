import { describe, expect, it } from "vitest";
import { errorText, isFailure, NO_ERROR, reportedAt, summarise } from "@/lib/rollout";
import type { NodeReport, RolloutStat } from "@/lib/rollout";

const stat = (result: string, count: number, error = NO_ERROR): RolloutStat =>
  ({ result, count, error });

describe("summarise", () => {
  /**
   * The distinction the whole module exists for. Both of these produce zero failures, and
   * showing them the same way is how a rollout that never left the ground reads as one that
   * went perfectly.
   */
  it("silence is its own state, not a clean pass", () => {
    expect(summarise([]).kind).toBe("silent");
    expect(summarise(undefined).kind).toBe("silent");
    // Groups the server sent with a zero count are still silence.
    expect(summarise([stat("success", 0)]).kind).toBe("silent");

    const reported = summarise([stat("success", 12)]);
    expect(reported.kind).toBe("reported");
    expect(reported).toMatchObject({ succeeded: 12, failed: 0 });
  });

  it("counts anything that is not success against the release", () => {
    const s = summarise([stat("success", 10), stat("verify_failed", 3), stat("apply_failed", 1)]);
    expect(s).toMatchObject({ kind: "reported", total: 14, succeeded: 10, failed: 4 });
  });

  it("a result nobody has seen before still counts as a failure", () => {
    // Listing the known failure results instead would silently pass any new one the node
    // learns to send — the release would look clean because the server got more specific.
    const s = summarise([stat("success", 1), stat("something_new_the_node_sends", 2)]);
    expect(s).toMatchObject({ failed: 2 });
    expect(isFailure(stat("something_new_the_node_sends", 2))).toBe(true);
    expect(isFailure(stat("success", 1))).toBe(false);
  });

  it("orders most common first, failures ahead of successes when tied", () => {
    const s = summarise([stat("success", 2), stat("verify_failed", 5), stat("apply_failed", 2)]);
    expect(s.kind === "reported" && s.groups.map((g) => g.result))
      .toEqual(["verify_failed", "apply_failed", "success"]);
  });
});

describe("fields a report may not carry", () => {
  it("(none) is a placeholder, not an error to display", () => {
    expect(errorText(stat("success", 1))).toBeNull();
    expect(errorText(stat("verify_failed", 1, ""))).toBeNull();
    expect(errorText(stat("verify_failed", 1, "sha256 mismatch"))).toBe("sha256 mismatch");
  });

  it("prefers the server's clock over the node's", () => {
    // A device with a dead RTC reports 1970 and would sort to the bottom of a list an
    // operator reads top-down.
    const report = {
      serial: "SN-1", at: "1970-01-01T00:00:00Z", received_at: "2026-09-10T09:00:00Z",
    } as NodeReport;
    expect(reportedAt(report)).toBe("2026-09-10T09:00:00Z");

    expect(reportedAt({ serial: "SN-2", at: "2026-09-10T08:00:00Z" } as NodeReport))
      .toBe("2026-09-10T08:00:00Z");
    expect(reportedAt({ serial: "SN-3" } as NodeReport)).toBe("");
  });
});
