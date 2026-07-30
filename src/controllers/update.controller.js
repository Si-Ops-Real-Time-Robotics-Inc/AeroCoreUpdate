import { etagMatches, readJsonBody, sendEmpty, sendJson } from '../core/http.js';
import { parseRange } from '../core/range.js';
import { sendFile } from '../core/files.js';
import { rangeNotSatisfiable } from '../core/errors.js';
import * as updateService from '../services/update.service.js';
import { resolveArtifact } from '../services/download.service.js';
import * as telemetry from '../repositories/telemetry.repository.js';
import {
  normalizeReport, validateCheckQuery, validateDownloadRequest,
} from '../validators/update.validator.js';

/** GET /api/v1/update/check — the single-node form (spec section 2). */
export async function checkGet(req, res) {
  const params = validateCheckQuery(req.query);
  const { etag, body, offered, system } = await updateService.checkSingleNode({
    ...params, fleet: req.fleet,
  });

  telemetry.logCheck({
    ...params,
    form: 'get',
    offered,
    system,
    updateAvailable: body.update_available,
    fleet: req.fleet,
  });

  if (etagMatches(req.headers['if-none-match'], etag)) {
    return sendEmpty(res, 304, { ETag: etag });
  }
  // etag is null when the service deliberately withheld a cacheable answer — a pre-signed
  // manifest that failed its serve-time re-verify. Send no ETag at all rather than the
  // string "null", so the node keeps asking and picks the release up once it is repaired.
  sendJson(res, 200, body, { ...(etag ? { ETag: etag } : {}), 'Cache-Control': 'no-cache' });
}

/** GET /api/v1/update/download/{version} (spec section 6). */
export async function download(req, res) {
  const { version, platform, system } = validateDownloadRequest(req.params, req.query);
  const artifact = await resolveArtifact(version, platform, system);

  // Conditional requests take precedence over Range (RFC 9110).
  if (etagMatches(req.headers['if-none-match'], artifact.etag)) {
    return sendEmpty(res, 304, { ETag: artifact.etag, 'Accept-Ranges': 'bytes' });
  }

  const range = parseRange(req.headers.range, artifact.size);
  if (range.type === 'unsatisfiable') throw rangeNotSatisfiable(artifact.size);

  const headers = {
    'Content-Type': 'application/gzip',
    'Accept-Ranges': 'bytes',
    ETag: artifact.etag,
    'Content-Disposition': `attachment; filename="${artifact.filename}"`,
  };

  if (range.type === 'satisfiable') {
    return sendFile(req, res, {
      filePath: artifact.filePath,
      start: range.start,
      end: range.end,
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${artifact.size}`,
      },
    });
  }

  await sendFile(req, res, {
    filePath: artifact.filePath, start: 0, end: artifact.size - 1, status: 200, headers,
  });
}

/** POST /api/v1/update/report (spec section 11). Never rejects on schema. */
export async function report(req, res) {
  const record = normalizeReport(await readJsonBody(req));
  await telemetry.insertReport(record, req.fleet);
  sendJson(res, 200, { ok: true });
}
