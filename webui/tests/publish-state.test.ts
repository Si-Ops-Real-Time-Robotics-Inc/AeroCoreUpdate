import { describe, expect, it } from "vitest";
import {
  isBusy,
  publishReducer,
  PUBLISH_EVENTS,
  type PublishState,
} from "@/lib/publish-state";

const file = new File(["x"], "bundle.tar.gz");
const staged = { token: "t1", stored: false } as never;
const idle: PublishState = { phase: "idle" };

const run = (start: PublishState, ...events: Parameters<typeof publishReducer>[1][]) =>
  events.reduce(publishReducer, start);

describe("publish state machine", () => {
  it("walks the ordinary path to a published release", () => {
    const end = run(
      idle,
      { type: "choose", file },
      { type: "hashing" },
      { type: "progress", loaded: 10, total: 100 },
      { type: "staged", staged },
      { type: "published", result: { stored: true } as never },
    );
    expect(end.phase).toBe("published");
  });

  it("keeps the file through a refusal, so a retry does not ask for it again", () => {
    const after = run(idle, { type: "choose", file }, { type: "hashing" }, { type: "failed" });
    expect(after).toEqual({ phase: "chosen", file });
  });

  it("keeps the file when platforms must be supplied", () => {
    const after = run(
      idle,
      { type: "choose", file },
      { type: "hashing" },
      { type: "needsPlatforms", message: "which devices?" },
    );
    expect(after).toMatchObject({ phase: "needsPlatforms", file });
  });

  it("discarding returns to idle and keeps no token", () => {
    const after = run(idle, { type: "choose", file }, { type: "staged", staged }, { type: "discard" });
    expect(after).toEqual({ phase: "idle" });
    expect(JSON.stringify(after)).not.toContain("t1");
  });

  it("ignores events that need a file when there is none", () => {
    // A stray progress event from a cancelled transfer must not invent a state.
    expect(publishReducer(idle, { type: "progress", loaded: 1, total: 2 })).toEqual(idle);
    expect(publishReducer(idle, { type: "staged", staged })).toEqual(idle);
  });

  it("marks only the two in-flight phases busy", () => {
    expect(isBusy({ phase: "hashing", file })).toBe(true);
    expect(isBusy({ phase: "sending", file, loaded: 0, total: 1 })).toBe(true);
    expect(isBusy(idle)).toBe(false);
    expect(isBusy({ phase: "staged", file, staged })).toBe(false);
  });

  /**
   * Constitution II, enforced rather than trusted. Publishing lands a release on
   * `beta`; moving a channel is a separate act by an admin elsewhere. If someone
   * adds a promote event to this screen, this fails and points at the reason.
   */
  it("has no event that reaches the fleet", () => {
    for (const event of PUBLISH_EVENTS) {
      expect(event).not.toMatch(/promote|channel|stable|ship|release-to/i);
    }
  });

  it("reaches no phase that represents a promoted release", () => {
    const reachable = new Set<string>();
    const seed: PublishState[] = [
      idle,
      { phase: "chosen", file },
      { phase: "hashing", file },
      { phase: "sending", file, loaded: 0, total: 1 },
      { phase: "staged", file, staged },
    ];
    for (const start of seed) {
      for (const type of PUBLISH_EVENTS) {
        const event = { type, file, loaded: 0, total: 1, staged, message: "m", result: {} } as never;
        reachable.add(publishReducer(start, event).phase);
      }
    }
    expect([...reachable].sort()).toEqual(
      ["chosen", "hashing", "idle", "needsPlatforms", "published", "sending", "staged"],
    );
  });
});
