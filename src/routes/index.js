import { Router } from '../core/router.js';
import { healthRoutes } from './health.routes.js';
import { updateRoutes } from './update.routes.js';
import { adminRoutes } from './admin.routes.js';

export const apiRoutes = new Router()
  .use('/api/v1', healthRoutes)
  .use('/api/v1', updateRoutes)
  .use('/admin', adminRoutes);
