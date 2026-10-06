import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError } from "@/lib/api";
import {
  CHANNEL_ROLLBACK,
  isSending,
  promoteReducer,
  rollbackFinding,
  type PromoteState,
  type Target,
} from "@/lib/promote";

const target: Target = {
  system: "gcs", channel: "stable", version: "1.4.0", losing: ["beta"],
};

const refusal = (details: unknown) =>
  new ApiError({
    status: 400, code: "invalid_parameter", message: "…older…", details,
  } as never);

const finding = { rule: CHANNEL_ROLLBACK, message: "…", from: "1.5.0", to: "1.4.0" };

describe("the promote state machine", () => {
  it("goes idle → confirming → sending → done", () => {
    let s: PromoteState = { phase: "idle" };
    s = promoteReducer(s, { type: "choose", target });
    expect(s.phase).toBe("confirming");
    s = promoteReducer(s, { type: "confirm" });
    expect(s).toMatchObject({ phase: "sending", override: false });
    s = promoteReducer(s, { type: "succeeded", released: ["beta"] });
    expect(s).toMatchObject({ phase: "done", released: ["beta"] });
  });

  it("reaches confirmingRollback ONLY from a refusal", () => {
    // The whole point: this state is the server's answer, never this screen's prediction.
    const fromIdle = promoteReducer({ phase: "idle" }, { type: "refused", finding });
    expect(fromIdle.phase).toBe("idle");

    const fromConfirming = promoteReducer(
      { phase: "confirming", target }, { type: "refused", finding },
    );
    expect(fromConfirming.phase).toBe("confirming");

    const fromSending = promoteReducer(
      { phase: "sending", target, override: false }, { type: "refused", finding },
    );
    expect(fromSending).toMatchObject({ phase: "confirmingRollback", from: "1.5.0", to: "1.4.0" });
  });

  it("carries the override only out of confirmingRollback", () => {
    const confirmed = promoteReducer(
      { phase: "confirmingRollback", target, from: "1.5.0", to: "1.4.0" }, { type: "confirm" },
    );
    expect(confirmed).toMatchObject({ phase: "sending", override: true });

    // And never out of the first question — an override there would be answering a refusal
    // that has not happened.
    const first = promoteReducer({ phase: "confirming", target }, { type: "confirm" });
    expect(first).toMatchObject({ phase: "sending", override: false });
  });

  it("declining either question ends somewhere that sends nothing", () => {
    for (const state of [
      { phase: "confirming", target } as PromoteState,
      { phase: "confirmingRollback", target, from: "1.5.0", to: "1.4.0" } as PromoteState,
    ]) {
      const cancelled = promoteReducer(state, { type: "decline" });
      expect(cancelled.phase).toBe("cancelled");

      // Nothing leads out of cancelled except starting over.
      for (const type of ["confirm", "succeeded", "refused"] as const) {
        const after = promoteReducer(cancelled, { type, released: [], finding } as never);
        expect(after.phase).toBe("cancelled");
      }
      expect(promoteReducer(cancelled, { type: "reset" }).phase).toBe("idle");
    }
  });

  it("a refusal without from/to does not become a rollback question", () => {
    // A confirmation that cannot name both versions is not a confirmation.
    const s = promoteReducer(
      { phase: "sending", target, override: false },
      { type: "refused", finding: { rule: CHANNEL_ROLLBACK, message: "…" } },
    );
    expect(s.phase).not.toBe("confirmingRollback");
  });

  it("any other failure returns to the question rather than forward", () => {
    const s = promoteReducer({ phase: "sending", target, override: false }, { type: "failed" });
    expect(s).toMatchObject({ phase: "confirming" });
  });

  it("isSending is true only in flight", () => {
    expect(isSending({ phase: "sending", target, override: false })).toBe(true);
    expect(isSending({ phase: "confirming", target })).toBe(false);
  });
});

describe("rollbackFinding", () => {
  it("keys on the rule, not the message", () => {
    expect(rollbackFinding(refusal([finding]))?.from).toBe("1.5.0");
    expect(rollbackFinding(refusal([{ rule: "other", message: "is older" }]))).toBeNull();
    expect(rollbackFinding(refusal(undefined))).toBeNull();
    expect(rollbackFinding(new Error("network"))).toBeNull();
  });
});

/**
 * The rule this feature must not break: the server owns the comparison.
 *
 * A client that decides for itself which of two versions is newer is a second opinion about
 * the one action that reaches an aircraft, and two opinions is one more than this system can
 * check. Enforced structurally rather than by review.
 */
describe("no client-side version comparison", () => {
  it("promote.ts compares no version strings", () => {
    const source = readFileSync(new URL("../src/lib/promote.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/localeCompare/);
    expect(code).not.toMatch(/\bisNewer\b|\bcompareVersions\b|\bparseVersion\b/);
    // `from` and `to` may only be read off the finding, never weighed against each other.
    expect(code).not.toMatch(/\bfrom\s*[<>]=?\s*|[<>]=?\s*\w*\.to\b/);
  });
});
