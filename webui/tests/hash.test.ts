import { describe, expect, it } from "vitest";
import { sha256 } from "@/lib/hash";

/**
 * Known vectors rather than a round-trip against the same code: a hex encoder
 * that drops leading zeros agrees with itself perfectly and disagrees with the
 * server, which is the only party whose opinion matters here.
 */
describe("sha256", () => {
  it("hashes an empty file to the published empty-string digest", async () => {
    await expect(sha256(new Blob([]))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to the published vector", async () => {
    await expect(sha256(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("pads bytes below 0x10, so no digit is lost", async () => {
    const digest = await sha256(new Blob(["abc"]));
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
