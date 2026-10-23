import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);
const app = await buildApp({ config });
await app.listen({ port: config.port, host: config.host });
console.log(`Server listening on http://${config.host}:${config.port}`);
