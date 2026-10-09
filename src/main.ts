/**
 * API entry point (hs_app credentials only).
 *   npm run start:api
 */
import 'dotenv/config';
import { createApiApp } from './api/app-factory.js';

const port = Number(process.env.PORT ?? 3100);
createApiApp()
  .then((app) => app.listen(port))
  .then(() => console.log(`API listening on :${port} (OpenAPI UI at /docs)`))
  .catch((err) => { console.error('API failed to start:', (err as Error).message); process.exit(1); });
