/**
 * Zero dependency server for Harness Forge.
 *
 * Serves the built app and forwards /api/llm/* to an OpenAI compatible
 * upstream. The proxy exists because some providers (Particle among them) do
 * not send CORS headers, so a browser cannot call them directly. The API key is
 * never stored here: it arrives in the Authorization header and is forwarded.
 *
 *   npm run build && npm run serve
 *   HARNESS_UPSTREAM=https://api.particle.ai/v1 PORT=8787 npm run serve
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const UPSTREAM = (process.env.HARNESS_UPSTREAM ?? 'https://api.particle.ai/v1').replace(/\/+$/, '');
const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

async function proxy(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, OPTIONS' }).end('Method Not Allowed');
    return;
  }
  const path = req.url.replace(/^\/api\/llm/, '') || '/chat/completions';
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const upstream = await fetch(`${UPSTREAM}${path}`, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] ?? 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      body: Buffer.concat(chunks),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `proxy could not reach ${UPSTREAM}: ${err.message}` } }));
  }
}

async function serveFile(res, path) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, safe === '/' ? 'index.html' : safe);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    const body = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/llm')) return proxy(req, res);
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
    return;
  }
  await serveFile(res, (req.url ?? '/').split('?')[0]);
});

server.listen(PORT, () => {
  console.log(`harness forge on http://localhost:${PORT}  (proxying /api/llm to ${UPSTREAM})`);
});
