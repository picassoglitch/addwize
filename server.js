// Local dev server: static files from public/ + the same API handler Vercel runs.
// Without DATABASE_URL it uses an embedded Postgres (PGlite) stored in .data/.
import { createServer } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import handler from './lib/app.js';

process.env.PGLITE_DIR ??= new URL('./.data/pglite', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = new URL('./public/', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};

function serveStatic(res, pathname) {
  // Mirrors vercel.json cleanUrls: /register -> register.html
  let file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!extname(file)) file += '.html';
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

export const server = createServer((req, res) =>
  req.url.startsWith('/api/') ? handler(req, res) : serveStatic(res, new URL(req.url, 'http://x').pathname),
);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  server.listen(PORT, () => {
    console.log(`Addwize Focus Challenge (dev) → http://localhost:${PORT}`);
    console.log(`  /register  ·  /play  ·  /admin (PIN ${process.env.ADMIN_PIN ? 'from ADMIN_PIN' : '4321'})`);
  });
}
