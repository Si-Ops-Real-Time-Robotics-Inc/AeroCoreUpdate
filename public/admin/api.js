/**
 * API wrapper for the admin UI.
 *
 * The access token is kept in a module variable, never in localStorage or sessionStorage:
 * anything readable by JavaScript is readable by an XSS payload. The refresh token lives in
 * an HttpOnly cookie the page cannot see at all.
 */

let accessToken = null;
let currentUser = null;

export const getUser = () => currentUser;
export const isSignedIn = () => Boolean(accessToken);

export function setSession({ access_token: token, user }) {
  accessToken = token;
  currentUser = user ?? currentUser;
}

export function clearSession() {
  accessToken = null;
  currentUser = null;
}

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    // Bundle inspection returns every finding at once so a broken bundle takes one upload
    // to diagnose, not one per mistake.
    this.details = details;
  }
}

async function toError(res) {
  let body = {};
  try {
    body = await res.json();
  } catch { /* not JSON */ }
  return new ApiError(res.status, body.error ?? 'server_error',
    body.message ?? `${res.status} ${res.statusText}`, body.details ?? null);
}

/** Exchange the refresh cookie for a new access token. Returns true on success. */
export async function refresh() {
  const res = await fetch('/admin/api/auth/refresh', {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch' },
  });
  if (!res.ok) return false;
  setSession(await res.json());
  return true;
}

/**
 * A 15-minute access token must not sign a user out in the middle of a 24 MB upload, so a
 * 401 triggers exactly one silent refresh-and-retry before giving up.
 */
export async function request(pathname, { method = 'GET', body, retry = true } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry) {
    if (await refresh()) return request(pathname, { method, body, retry: false });
    clearSession();
    throw new ApiError(401, 'invalid_api_key', 'Session expired');
  }

  if (!res.ok) throw await toError(res);
  return res.status === 204 ? null : res.json();
}


/**
 * Whether this server accepts sign-ups. Answered before anyone has a credential, so the page
 * can draw the form or leave it out rather than offering one that always fails.
 *
 * Any failure reads as "no": a sign-up form that cannot work is worse than none.
 */
export async function registrationEnabled() {
  try {
    const res = await fetch('/admin/api/auth/registration');
    if (!res.ok) return false;
    return Boolean((await res.json()).enabled);
  } catch {
    return false;
  }
}

/**
 * Whether this server has a Keycloak client configured for the browser sign-in, and whether
 * Keycloak is answering right now.
 *
 * The second half is what the page needs before redirecting anyone automatically: sending an
 * operator to an identity provider that is down strands them on a dead address, and this
 * server has no other way in to offer.
 *
 * Any failure reads as "neither", for the same reason the registration probe does: a sign-in
 * route that cannot work is worse than none.
 */
export async function keycloakLogin() {
  try {
    const res = await fetch('/admin/api/auth/oidc');
    if (!res.ok) return { enabled: false, reachable: false };
    const body = await res.json();
    return { enabled: Boolean(body.enabled), reachable: Boolean(body.reachable) };
  } catch {
    return { enabled: false, reachable: false };
  }
}

export async function register({ username, email, password }) {
  const res = await fetch('/admin/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: email || undefined, password }),
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function logout() {
  await fetch('/admin/api/auth/logout', {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch' },
  }).catch(() => {});
  clearSession();
}

/** SHA-256 of a File, hex, so the server can reject a corrupted upload before storing it. */
export async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload with real progress. fetch cannot report upload progress, so this uses XHR — and
 * because the body is the raw file, no multipart parser is needed on either side.
 */
export function upload(url, file, { expectedSha256, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/gzip');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    if (expectedSha256) xhr.setRequestHeader('X-Expected-Sha256', expectedSha256);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    });

    xhr.addEventListener('load', () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch { /* not JSON */ }

      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else {
        reject(new ApiError(xhr.status, body.error ?? 'server_error',
          body.message ?? `${xhr.status} ${xhr.statusText}`, body.details ?? null));
      }
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, 'server_error', 'Network error')));
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'server_error', 'Upload aborted')));

    xhr.send(file);
  });
}
