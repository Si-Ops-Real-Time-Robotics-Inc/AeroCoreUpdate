import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  CONFIG_NEEDS_PLATFORMS,
  findings,
  needsPlatforms,
  progressPercent,
  stageBundle,
} from "@/lib/upload";

describe("progressPercent", () => {
  it("reports whole percentages", () => {
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(200, 200)).toBe(100);
  });

  it("survives a total of zero rather than rendering NaN", () => {
    // Some proxies leave lengthComputable false, and upload.ts then passes 0.
    expect(progressPercent(10, 0)).toBe(0);
  });

  it("never exceeds its own bounds", () => {
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(-5, 200)).toBe(0);
  });
});

describe("needsPlatforms", () => {
  const refusal = (rule: string) =>
    new ApiError({
      status: 400,
      code: "invalid_parameter",
      message: "irrelevant prose",
      details: [{ rule, message: "…" }],
    });

  it("fires on the rule the bundle cannot answer for itself", () => {
    expect(needsPlatforms(refusal(CONFIG_NEEDS_PLATFORMS))).toBe(true);
  });

  it("does not fire on any other refusal", () => {
    expect(needsPlatforms(refusal("core_slice_package_mismatch"))).toBe(false);
  });

  it("keys off the rule, not the message", () => {
    // The message is prose and gets reworded; the rule is the contract.
    const misleading = new ApiError({
      status: 400,
      code: "invalid_parameter",
      message: "this config-only bundle needs platforms",
      details: [{ rule: "something_else", message: "…" }],
    });
    expect(needsPlatforms(misleading)).toBe(false);
  });

  it("treats a refusal with no findings as ordinary", () => {
    expect(needsPlatforms(new ApiError({ status: 413, code: "invalid_parameter", message: "too big" }))).toBe(false);
    expect(needsPlatforms(new Error("network"))).toBe(false);
    expect(findings(new Error("network"))).toEqual([]);
  });
});

/** Minimal XHR good enough to drive stageBundle's four listeners. */
class FakeXHR {
  static last: FakeXHR | undefined;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  status = 200;
  statusText = "OK";
  responseText = "";
  sent: unknown = null;
  upload = { listeners: {} as Record<string, (e: unknown) => void>,
    addEventListener(type: string, fn: (e: unknown) => void) { this.listeners[type] = fn; } };
  private listeners: Record<string, () => void> = {};

  constructor() { FakeXHR.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  send(body: unknown) { this.sent = body; }
  fire(type: string) { this.listeners[type]?.(); }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.listeners.progress?.({ loaded, total, lengthComputable });
  }
}

describe("stageBundle", () => {
  const file = new File(["payload"], "bundle.tar.gz");

  beforeEach(() => {
    // Cleared between tests on purpose. Waiting on `last.sent` alone would return
    // the PREVIOUS test's instance the instant it is checked — the same File is
    // reused, so the stale one already satisfies the condition.
    FakeXHR.last = undefined;
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    vi.stubGlobal("window", { location: { replace: vi.fn() } });
  });

  /** Waits for stageBundle to construct a NEW request, not the one before it. */
  async function freshXhr(): Promise<FakeXHR> {
    const previous = FakeXHR.last;
    await vi.waitFor(() => {
      if (FakeXHR.last === previous) throw new Error("no new request yet");
    });
    return FakeXHR.last!;
  }

  it("sends the raw file with the headers the server requires", async () => {
    const promise = stageBundle(file, { expectedSha256: "abc123" });
    const xhr = await freshXhr();
    expect(xhr.sent).toBe(file);
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/admin/api/uploads");
    expect(xhr.headers["Content-Type"]).toBe("application/gzip");
    expect(xhr.headers["X-Requested-With"]).toBe("fetch");
    expect(xhr.headers["X-Expected-SHA256"]).toBe("abc123");

    xhr.responseText = JSON.stringify({ token: "t1", stored: false });
    xhr.fire("load");
    await expect(promise).resolves.toMatchObject({ token: "t1", stored: false });
  });

  it("puts chosen platforms in the query, and omits the parameter otherwise", async () => {
    const withPlatforms = stageBundle(file, { expectedSha256: "x", platforms: ["linux-x64", "android-arm64"] });
    const first = await freshXhr();
    expect(first.url).toBe("/admin/api/uploads?platforms=linux-x64%2Candroid-arm64");
    first.responseText = "{}";
    first.fire("load");
    await withPlatforms;

    const without = stageBundle(file, { expectedSha256: "x", platforms: [] });
    const second = await freshXhr();
    expect(second.url).toBe("/admin/api/uploads");
    second.responseText = "{}";
    second.fire("load");
    await without;
  });

  it("reports progress, and reports a zero total when the length is unknown", async () => {
    const seen: Array<[number, number]> = [];
    const promise = stageBundle(file, { expectedSha256: "x", onProgress: (l, t) => seen.push([l, t]) });
    const xhr = await freshXhr();

    xhr.progress(25, 100);
    xhr.progress(60, 100, false);
    expect(seen).toEqual([[25, 100], [60, 0]]);

    xhr.responseText = "{}";
    xhr.fire("load");
    await promise;
  });

  it("takes the error code from the envelope's `error` field, not `code`", async () => {
    const promise = stageBundle(file, { expectedSha256: "x" });
    const caught = promise.catch((err) => err as ApiError);
    const xhr = await freshXhr();

    xhr.status = 400;
    xhr.responseText = JSON.stringify({
      error: "invalid_parameter",
      message: "no platforms",
      details: [{ rule: CONFIG_NEEDS_PLATFORMS, message: "no platforms" }],
    });
    xhr.fire("load");

    const err = await caught;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("invalid_parameter");
    expect(needsPlatforms(err)).toBe(true);
  });

  it("surfaces a transport failure rather than hanging on the progress bar", async () => {
    const promise = stageBundle(file, { expectedSha256: "x" });
    const rejected = expect(promise).rejects.toThrow(/could not reach the server/);
    (await freshXhr()).fire("error");
    await rejected;
  });

  it("does not choke on a non-JSON body from something in front of the server", async () => {
    const promise = stageBundle(file, { expectedSha256: "x" });
    const rejected = expect(promise).rejects.toThrow(/Bad Gateway/);
    const xhr = await freshXhr();
    xhr.status = 502;
    xhr.statusText = "Bad Gateway";
    xhr.responseText = "<html>nginx</html>";
    xhr.fire("load");
    await rejected;
  });
});
