import { config } from '../config/index.js';
import { parseCookies, readJsonBody, sendJson, serializeCookie } from '../core/http.js';
import { invalidParameter, missingParameter, unauthorized } from '../core/errors.js';
import * as authService from '../services/auth.service.js';

const COOKIE = 'aeroserver_refresh';
const COOKIE_PATH = '/admin/api/auth';

/**
 * The refresh token lives in an HttpOnly cookie, so JavaScript — and therefore an XSS
 * payload — can never read it. `Secure` only works over HTTPS, which is what the
 * HTTPS-everywhere decision buys here.
 */
function setRefreshCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: COOKIE_PATH,
    maxAge: config.refreshTtlSeconds,
  }));
}

function clearRefreshCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'Strict', path: COOKIE_PATH, maxAge: 0,
  }));
}

const clientIp = (req) => req.socket?.remoteAddress ?? null;

/**
 * Cookie-bearing endpoints have a CSRF surface. SameSite=Strict and the narrow Path are the
 * first two defences; requiring a custom header is the third, because a plain HTML form
 * cannot set one. Endpoints that use Authorization instead are immune by construction.
 */
function requireFetchHeader(req) {
  if (req.headers['x-requested-with'] !== 'fetch') {
    throw invalidParameter('X-Requested-With: fetch is required');
  }
}

export async function login(req, res) {
  const body = await readJsonBody(req);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username) throw missingParameter('username');
  if (!password) throw missingParameter('password');

  const result = await authService.login({
    username,
    password,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  });

  setRefreshCookie(res, result.refreshToken);
  sendJson(res, 200, {
    access_token: result.accessToken,
    expires_in: result.expiresIn,
    user: result.user,
  });
}

export async function refresh(req, res) {
  requireFetchHeader(req);
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) throw unauthorized('No refresh token');

  const result = await authService.refresh({
    token, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null,
  });

  setRefreshCookie(res, result.refreshToken);
  sendJson(res, 200, {
    access_token: result.accessToken,
    expires_in: result.expiresIn,
    user: result.user,
  });
}

export async function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await authService.logout(token);
  clearRefreshCookie(res);
  sendJson(res, 200, { ok: true });
}

export async function logoutAll(req, res) {
  const revoked = await authService.logoutAll(req.user.id);
  clearRefreshCookie(res);
  sendJson(res, 200, { ok: true, revoked });
}

export async function me(req, res) {
  sendJson(res, 200, {
    id: req.user.id,
    username: req.user.username,
    last_login_at: req.user.lastLoginAt,
    password_changed_at: req.user.passwordChangedAt,
  });
}

export async function changePassword(req, res) {
  const body = await readJsonBody(req);
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';

  if (!current) throw missingParameter('current_password');
  if (!next) throw missingParameter('new_password');
  if (next.length < 12) throw invalidParameter('new_password must be at least 12 characters');
  if (next === current) throw invalidParameter('new_password must differ from the current one');

  const revoked = await authService.changePassword({
    user: req.user, currentPassword: current, newPassword: next,
  });

  // Every session, including this browser's, is now invalid: sign in again.
  clearRefreshCookie(res);
  sendJson(res, 200, { ok: true, revoked_sessions: revoked });
}
