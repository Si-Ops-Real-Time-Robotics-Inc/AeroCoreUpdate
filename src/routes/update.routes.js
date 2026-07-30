import { Router } from '../core/router.js';
import { requireApiKey } from '../middlewares/apiKey.js';
import * as update from '../controllers/update.controller.js';

/** Every fleet endpoint requires X-API-Key. /api/v1/health is registered separately. */
export const updateRoutes = new Router()
  .get('/update/check', requireApiKey(update.checkGet))
  .get('/update/download/:version', requireApiKey(update.download))
  .post('/update/report', requireApiKey(update.report));
