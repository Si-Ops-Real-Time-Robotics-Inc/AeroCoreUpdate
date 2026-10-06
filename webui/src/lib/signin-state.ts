import type { components } from "@/api/schema";

export type OidcStatus = components["schemas"]["OidcStatus"];

/**
 * What the sign-in screen should say.
 *
 * There is one way in, so the states that are NOT "sign in here" all describe a
 * different reason nobody can — and each needs its own sentence. Collapsing them
 * into one failure message is how an operator spends an hour on a provider
 * outage that the screen already knew about.
 */
export type SignInState =
  | { kind: "checking" }
  /** Everything agrees: offer the button. */
  | { kind: "ready" }
  /** Configured on both sides, but the realm is not answering right now. */
  | { kind: "provider-down" }
  /** The server has no provider configured at all. */
  | { kind: "not-configured" }
  /** The server has one; this build of the UI was not given the issuer. */
  | { kind: "bundle-missing-issuer" }
  /** The server did not answer when asked how to sign in. */
  | { kind: "server-unreachable" };

export function signInState(
  bundleHasIssuer: boolean,
  status: OidcStatus | undefined,
  { loading = false, failed = false } = {},
): SignInState {
  if (failed) return { kind: "server-unreachable" };
  if (loading || !status) return { kind: "checking" };
  if (!status.enabled) return { kind: "not-configured" };
  if (!bundleHasIssuer) return { kind: "bundle-missing-issuer" };
  if (!status.reachable) return { kind: "provider-down" };
  return { kind: "ready" };
}
