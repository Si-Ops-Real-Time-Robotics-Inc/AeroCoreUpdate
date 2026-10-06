import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpError, invalidApiKey, invalidParameter, maintenance, methodNotAllowed, missingParameter,
  notFound, rangeNotSatisfiable, rateLimited, serverError, upgradeRequired, upstreamUnavailable,
} from '../src/core/errors.js';

/** The closed enum from spec section 1. Nothing may invent a code outside it. */
const CODES = new Set([
  'missing_parameter', 'invalid_parameter', 'invalid_api_key', 'not_found',
  'range_not_satisfiable', 'rate_limited', 'server_error', 'maintenance',
]);

test('every factory produces a status and a documented code', () => {
  const cases = [
    [missingParameter('serial'), 400, 'missing_parameter'],
    [invalidParameter('bad'), 400, 'invalid_parameter'],
    [invalidApiKey(), 401, 'invalid_api_key'],
    [notFound(), 404, 'not_found'],
    [methodNotAllowed('nope', 'GET'), 405, 'not_found'],
    [rangeNotSatisfiable(100), 416, 'range_not_satisfiable'],
    [upgradeRequired(), 426, 'invalid_parameter'],
    [rateLimited(60), 429, 'rate_limited'],
    [serverError(), 500, 'server_error'],
    [maintenance(300), 503, 'maintenance'],
    [upstreamUnavailable(), 503, 'maintenance'],
  ];

  for (const [err, status, code] of cases) {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status, code);
    assert.equal(err.code, code);
    assert.ok(CODES.has(err.code), `${err.code} is not in the section 1 enum`);
  }
});

/**
 * Regression: the factories used to pass the header map as the options object itself, so the
 * constructor's `{ headers }` destructuring silently dropped every one of them. The spec
 * REQUIRES Content-Range on a 416 and Retry-After on 429/503, so the loss was invisible and
 * non-compliant at the same time.
 */
test('errors that must carry headers actually carry them', () => {
  assert.deepEqual(methodNotAllowed('nope', 'GET, POST').headers, { Allow: 'GET, POST' });

  assert.deepEqual(rangeNotSatisfiable(12582912).headers, {
    'Content-Range': 'bytes */12582912',
    'Accept-Ranges': 'bytes',
  });

  assert.deepEqual(rateLimited(900).headers, { 'Retry-After': '900' });
  assert.deepEqual(maintenance(300).headers, { 'Retry-After': '300' });
  assert.deepEqual(upgradeRequired().headers, { Upgrade: 'TLS/1.2, HTTP/1.1' });
});

test('errors with nothing to add carry an empty header map, never undefined', () => {
  for (const err of [missingParameter('x'), invalidParameter(), notFound(), serverError(),
    invalidApiKey(), methodNotAllowed('nope')]) {
    assert.deepEqual(err.headers, {}, err.code);
  }
});

test('missingParameter names the parameter, because the node reports it to an operator', () => {
  assert.equal(missingParameter('serial').message, 'serial is required');
});
