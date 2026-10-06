/**
 * The platforms the protocol names.
 *
 * Mirrors `KNOWN_PLATFORMS` in `src/domain/platform.js`. It is duplicated rather
 * than derived because the OpenAPI contract deliberately does NOT close
 * `Platform` into an enum: with `STRICT_PLATFORMS` off the server accepts any
 * value matching its pattern, and a spec enum would refuse values the server
 * allows.
 *
 * Duplication without a guard is drift, so `tests/openapi.test.js` asserts this
 * list equals the server's, in both directions.
 */
export const KNOWN_PLATFORMS = [
  "linux-x86_64", "linux-aarch64", "linux-arm", "linux-x86",
  "windows-x86_64", "windows-aarch64", "windows-x86",
  "android-aarch64", "android-x86_64", "android-arm", "android-x86",
  "macos-x86_64", "macos-aarch64",
] as const;

export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];

/**
 * An Android core binary cannot be replaced over the air (protocol section 5),
 * so an Android-only selection publishes plugins and configuration and nothing
 * else. Worth saying on the picker rather than discovering afterwards.
 */
export function isAndroid(platform: string): boolean {
  return platform.startsWith("android-");
}

/** True when every chosen platform is Android — see isAndroid for why it matters. */
export function androidOnly(platforms: readonly string[]): boolean {
  return platforms.length > 0 && platforms.every(isAndroid);
}
