import { Router } from '../core/router.js';
import { health } from '../controllers/health.controller.js';

export const healthRoutes = new Router().get('/health', health);
