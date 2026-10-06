import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

/**
 * One way in.
 *
 * Keycloak, hosted by proxy_alpha and shared with the rest of the platform. This
 * UI holds no password, mints no identity and stores no credential of its own —
 * it presents a token the realm issued and nothing else (Constitution I, 2.0.0).
 *
 * A PUBLIC client doing Authorization Code + PKCE. The server-side code exchange
 * that preceded it existed because a confidential client's secret had to stay
 * off the browser; a public client removes the secret instead of hiding it.
 */

const issuer = import.meta.env.VITE_OIDC_ISSUER ?? "";
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? "aeroserver-webui";

/** Whether Keycloak is configured at all. Without it only the password form is offered. */
export const oidcConfigured = Boolean(issuer);

const userManager = oidcConfigured
  ? new UserManager({
      authority: issuer,
      client_id: clientId,
      redirect_uri: `${window.location.origin}/admin/callback`,
      post_logout_redirect_uri: `${window.location.origin}/admin/`,
      response_type: "code",
      scope: "openid profile email",
      automaticSilentRenew: true,
      includeIdTokenInSilentRenew: false,
      // sessionStorage, not localStorage: a token that outlives the tab is a
      // token left behind on a shared workshop machine.
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    })
  : null;

export async function login(returnTo?: string): Promise<void> {
  if (!userManager) throw new Error("Keycloak is not configured on this server");
  await userManager.signinRedirect({
    state: returnTo ?? window.location.pathname + window.location.search,
  });
}

export async function completeLogin(): Promise<string> {
  if (!userManager) throw new Error("Keycloak is not configured on this server");
  const user = await userManager.signinRedirectCallback();
  return (user.state as string) ?? "/admin/";
}

export async function currentUser(): Promise<User | null> {
  if (!userManager) return null;
  const user = await userManager.getUser();
  if (!user || user.expired) return null;
  return user;
}

/** The bearer token for the admin API. Null when signed out. */
export async function accessToken(): Promise<string | null> {
  return (await currentUser())?.access_token ?? null;
}

export async function dropSession(): Promise<void> {
  await userManager?.removeUser();
}

/**
 * Ends the session the SERVER holds.
 *
 * The refresh token is an HttpOnly cookie: this code cannot see it and cannot
 * clear it. Dropping the access token in this tab therefore signs nobody out —
 * the next load trades that cookie for a fresh token and walks straight back
 * in, so "sign out" reloads to exactly where it started. The server endpoint is
 * what clears the cookie and, if the session came from Keycloak, what ends the
 * session there too.
 *
 * Deliberately NOT called from dropSession(): a 401 means the access token went
 * stale, and the cookie is usually still good — throwing it away there would
 * turn a recoverable blip into a sign-out.
 */
async function endServerSession(): Promise<void> {
  try {
    await fetch("/admin/api/auth/logout", {
      method: "POST",
      // Cookie-bearing and therefore CSRF-exposed; a plain HTML form cannot set
      // a custom header, which is what makes this the defence.
      headers: { "X-Requested-With": "fetch" },
    });
  } catch {
    // Unreachable server. Still clear what this tab holds — leaving the page
    // rendering a signed-in shell would be worse than a cookie outliving it.
  }
}

export async function logout(): Promise<void> {
  const viaKeycloak = Boolean(await currentUser());
  await endServerSession();

  if (viaKeycloak && userManager) {
    // Ends the realm session too, otherwise signing back in is invisible and
    // "sign out" does not look like it did anything. This navigates away, so
    // nothing below it runs.
    await userManager.signoutRedirect();
    return;
  }
  await userManager?.removeUser();
  window.location.assign("/admin/");
}

/**
 * Calls back when the session is gone and cannot be renewed, so the shell can
 * stop rendering a signed-in page whose every request answers 401.
 */
export function onSessionLost(fn: () => void): () => void {
  if (!userManager) return () => {};
  const handler = () => {
    void userManager.removeUser().finally(fn);
  };
  userManager.events.addAccessTokenExpired(handler);
  userManager.events.addUserSignedOut(handler);
  return () => {
    userManager.events.removeAccessTokenExpired(handler);
    userManager.events.removeUserSignedOut(handler);
  };
}
