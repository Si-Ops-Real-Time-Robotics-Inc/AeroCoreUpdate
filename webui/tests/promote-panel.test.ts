import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { promoteReducer, type PromoteState, type Target } from "@/lib/promote";

/**
 * The two confirmations are different questions, and the property worth testing is that
 * neither can be skipped and neither stands in for the other.
 *
 * Asserted against the state machine rather than a rendered tree: the machine is what decides
 * whether anything is sent, and a test that only checks which words appear would pass on a
 * screen that showed the right sentence and sent the request anyway.
 */

const target = (losing: string[] = []): Target => ({
  system: "gcs", channel: "stable", version: "1.4.0", losing,
});

const finding = { rule: "channel_rollback", message: "…", from: "1.5.0", to: "1.4.0" };

describe("an ordinary forward move", () => {
  it("asks once, and nothing is sent until it is answered", () => {
    let s: PromoteState = promoteReducer({ phase: "idle" }, { type: "choose", target: target() });

    // Chosen is not sent. The screen is at a question.
    expect(s.phase).toBe("confirming");
    expect(s).not.toMatchObject({ phase: "sending" });

    s = promoteReducer(s, { type: "confirm" });
    expect(s).toMatchObject({ phase: "sending", override: false });

    s = promoteReducer(s, { type: "succeeded", released: [] });
    expect(s.phase).toBe("done");
  });

  it("says nothing about clearing another channel when none would be cleared", () => {
    const s = promoteReducer({ phase: "idle" }, { type: "choose", target: target([]) });
    expect(s.phase === "confirming" && s.target.losing).toEqual([]);
  });

  it("names the channels that lose the release when there are some", () => {
    const s = promoteReducer({ phase: "idle" }, { type: "choose", target: target(["beta"]) });
    expect(s.phase === "confirming" && s.target.losing).toEqual(["beta"]);
  });
});

describe("a backward move", () => {
  it("asks a SECOND time, and only after the server refuses", () => {
    let s: PromoteState = promoteReducer({ phase: "idle" }, { type: "choose", target: target() });
    s = promoteReducer(s, { type: "confirm" });
    expect(s).toMatchObject({ phase: "sending", override: false });

    // The first confirmation did not authorise the override. Only the refusal opens it.
    s = promoteReducer(s, { type: "refused", finding });
    expect(s).toMatchObject({ phase: "confirmingRollback", from: "1.5.0", to: "1.4.0" });

    s = promoteReducer(s, { type: "confirm" });
    expect(s).toMatchObject({ phase: "sending", override: true });
  });

  it("declining the second question sends nothing further", () => {
    const cancelled = promoteReducer(
      { phase: "confirmingRollback", target: target(), from: "1.5.0", to: "1.4.0" },
      { type: "decline" },
    );
    expect(cancelled.phase).toBe("cancelled");
    expect(promoteReducer(cancelled, { type: "confirm" }).phase).toBe("cancelled");
  });
});

describe("the panel itself", () => {
  const source = readFileSync(
    new URL("../src/components/systems/PromotePanel.tsx", import.meta.url), "utf8",
  );

  it("is an inline panel, not a dialog", () => {
    // `/admin/*` is served with `style-src 'self'` and no 'unsafe-inline'; the dialog
    // primitive positions itself with inline styles and would render unstyled over the page.
    expect(source).not.toMatch(/from "@\/components\/ui\/dialog"/);
    expect(source).not.toMatch(/\bstyle=\{/);
  });

  it("states both versions in the rollback question", () => {
    // A confirmation that cannot name what it is confirming is a rubber stamp.
    expect(source).toMatch(/state\.from/);
    expect(source).toMatch(/state\.to/);
  });
});
