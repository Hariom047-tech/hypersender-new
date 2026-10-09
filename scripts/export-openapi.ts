/** Writes docs/openapi.json from the live controller metadata:  npm run openapi */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/api/openapi.js';
import { createApiApp } from '../src/api/app-factory.js';

process.env.REALTIME_BUS = 'memory';
const app = await createApiApp({ swagger: false });
const doc = buildOpenApiDocument(app);
writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
await app.close();
console.log(`docs/openapi.json written (${Object.keys(doc.paths).length} paths)`);
