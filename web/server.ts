// Production server: serves the built client from dist/ plus the token endpoint.
// Runs directly on Node 24 (native TypeScript type stripping): `node server.ts`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { handleToken } from './token.ts';

const DIST = join(import.meta.dirname, 'dist');
const PORT = Number(process.env.PORT ?? 8080);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
};

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/api/token') return handleToken(process.env, req, res);
  if (path === '/healthz') return void res.end('ok');

  const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
  if (!file.startsWith(DIST + sep)) {
    res.statusCode = 400;
    return void res.end();
  }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (path.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, () => console.log(`listening on :${PORT}`));
