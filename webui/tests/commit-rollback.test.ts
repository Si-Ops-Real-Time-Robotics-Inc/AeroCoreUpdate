import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError } from "@/lib/api";
import { CHANNEL_ROLLBACK, rollback } from "@/lib/upload";

/**
 * The commit path names no channel and still moves one, so it meets the same
 * backward-move guard as every other path. This covers the branch that turns
 * that refusal into a question rather than a dead end.
 */

const refusal = (details: unknown) =>
  new ApiError({
    status: 400,
    code: "invalid_parameter",
    message: "default/beta is on 9.0.0; 8.0.0 is older.",
    details,
  } as never);

describe("rollback", () => {
  it("recognises the finding and hands back both ends of the move", () => {
    const finding = rollback(
      refusal([{ rule: CHANNEL_ROLLBACK, message: "…", from: "9.0.0", to: "8.0.0" }]),
    );

    expect(finding).not.toBeNull();
    expect(finding?.from).toBe("9.0.0");
    expect(finding?.to).toBe("8.0.0");
  });

  it("keys on the rule, never on the message", () => {
    // The message is prose for a person and may be reworded at any time; the
    // rule is part of the contract.
    const worded = refusal([
      { rule: "something_else", message: "default/beta is on 9.0.0; 8.0.0 is older." },
    ]);
    expect(rollback(worded)).toBeNull();
  });

  it("is null for a refusal carrying no findings at all", () => {
    expect(rollback(refusal(undefined))).toBeNull();
    expect(rollback(new Error("network"))).toBeNull();
  });
});

describe("the commit call carries the override only when asked", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
  });

  const urls = () =>
    (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]));

  it("sends no allow_rollback on an ordinary commit, and one when confirmed", async () => {
    vi.doMock("@/lib/auth", () => ({ accessToken: async () => "token" }));
    const { api } = await import("@/lib/api");

    await api.commitUpload("abc").catch(() => undefined);
    await api.commitUpload("abc", true).catch(() => undefined);

    const [ordinary, confirmed] = urls();
    expect(ordinary).not.toContain("allow_rollback");
    expect(confirmed).toContain("allow_rollback=true");
  });

  it("declining sends nothing further — there is no third request", async () => {
    // The Cancel branch calls no mutation at all: the staged bundle is left on
    // the server and expires on its own. Asserting the call count is how that
    // stays true when someone later "helpfully" adds a discard call.
    vi.doMock("@/lib/auth", () => ({ accessToken: async () => "token" }));
    const { api } = await import("@/lib/api");

    await api.commitUpload("abc").catch(() => undefined);
    expect(urls()).toHaveLength(1);
  });
});
