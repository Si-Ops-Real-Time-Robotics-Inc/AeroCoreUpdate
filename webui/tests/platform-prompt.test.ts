import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { androidOnly, isAndroid, KNOWN_PLATFORMS } from "@/lib/platforms";
import { CONFIG_NEEDS_PLATFORMS, needsPlatforms } from "@/lib/upload";

describe("the platform picker's list", () => {
  it("offers the thirteen the protocol names", () => {
    expect(KNOWN_PLATFORMS).toHaveLength(13);
    expect(new Set(KNOWN_PLATFORMS).size).toBe(13);
  });

  it("names every family a node can run on", () => {
    for (const family of ["linux-", "windows-", "android-", "macos-"]) {
      expect(KNOWN_PLATFORMS.some((p) => p.startsWith(family))).toBe(true);
    }
  });
});

describe("androidOnly", () => {
  it("warns only when nothing but Android was chosen", () => {
    // An Android core binary cannot be replaced over the air, so this selection
    // publishes plugins and configuration and nothing else.
    expect(androidOnly(["android-arm", "android-x86"])).toBe(true);
    expect(androidOnly(["android-arm", "linux-x86_64"])).toBe(false);
  });

  it("says nothing when nothing is chosen yet", () => {
    expect(androidOnly([])).toBe(false);
  });

  it("matches on the family prefix, not on the word appearing anywhere", () => {
    expect(isAndroid("android-aarch64")).toBe(true);
    expect(isAndroid("linux-android-thing")).toBe(false);
  });
});

describe("when the prompt appears", () => {
  const refusal = (...rules: string[]) =>
    new ApiError({
      status: 400,
      code: "invalid_parameter",
      message: "refused",
      details: rules.map((rule) => ({ rule, message: "…" })),
    });

  it("appears when the rule is among several findings", () => {
    expect(needsPlatforms(refusal("some_warning", CONFIG_NEEDS_PLATFORMS))).toBe(true);
  });

  it("stays away for every other refusal, however similar", () => {
    expect(needsPlatforms(refusal("config_only"))).toBe(false);
    expect(needsPlatforms(refusal("needs_platforms"))).toBe(false);
    expect(needsPlatforms(refusal())).toBe(false);
  });

  it("stays away when details is not a list of findings", () => {
    const odd = new ApiError({ status: 400, code: "invalid_parameter", message: "x", details: { rule: CONFIG_NEEDS_PLATFORMS } });
    expect(needsPlatforms(odd)).toBe(false);
  });
});
