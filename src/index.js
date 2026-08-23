import { resolve } from 'node:path';
import { Atlas } from './atlas.js';
import { createServer, listen } from './server.js';

const port = Number.parseInt(process.env.ATLAS_PORT ?? '4817', 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ATLAS_PORT must be a valid TCP port.');
const databasePath = resolve(process.env.ATLAS_DATABASE ?? 'data/atlas.sqlite');
const publicDir = resolve(process.env.ATLAS_PUBLIC_DIR ?? 'public');
const atlas = new Atlas({ databasePath });
const server = createServer({ atlas, publicDir });

await listen(server, { port });
process.once('exit', () => atlas.close());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
