import { describe, expect, it } from "vitest";
import { signInState } from "@/lib/signin-state";

const up = { enabled: true, reachable: true };
const down = { enabled: true, reachable: false };
const off = { enabled: false, reachable: false };

describe("what the sign-in screen says", () => {
  it("offers the button only when all three agree", () => {
    expect(signInState(true, up).kind).toBe("ready");
  });

  it("names a provider outage as an outage", () => {
    // Not "sign-in failed": there is nothing else to try, and saying so is the
    // difference between thirty seconds and an hour of misdirected debugging.
    expect(signInState(true, down).kind).toBe("provider-down");
  });

  it("distinguishes a server with no provider from one whose provider is down", () => {
    expect(signInState(true, off).kind).toBe("not-configured");
  });

  it("distinguishes a bundle built without an issuer from either", () => {
    // The server is fine; this build cannot talk to it. A different fix entirely.
    expect(signInState(false, up).kind).toBe("bundle-missing-issuer");
  });

  it("says the server is unreachable rather than guessing", () => {
    expect(signInState(true, undefined, { failed: true }).kind).toBe("server-unreachable");
  });

  it("shows nothing decisive while the answer is still in flight", () => {
    expect(signInState(true, undefined, { loading: true }).kind).toBe("checking");
    expect(signInState(true, undefined).kind).toBe("checking");
  });

  it("never offers sign-in on a server that has no provider, whatever the bundle knows", () => {
    for (const bundle of [true, false]) {
      expect(signInState(bundle, off).kind).not.toBe("ready");
    }
  });
});
