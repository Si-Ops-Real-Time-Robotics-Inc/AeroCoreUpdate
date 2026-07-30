import { notFound } from '../core/errors.js';

/** Last link in the chain: nothing handled the request, so return 404. */
export function notFoundHandler() {
  return async (req) => {
    throw notFound(`Cannot ${req.method} ${req.pathname}`);
  };
}
