import { sendJson } from '../core/http.js';
import { config } from '../config/index.js';
import { isHealthy } from '../db/pool.js';

/**
 * GET /api/v1/health (spec section 12). No auth: it exists so a node — and monitoring — can
 * tell "server unreachable" from "no update available".
 *
 * A dead database is a third state, and saying ok:true while unable to answer any check
 * would be a lie, so the flag reflects it.
 */
export async function health(req, res) {
  const ok = await isHealthy();
  sendJson(res, 200, {
    ok,
    service: config.serviceName,
    time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
}
