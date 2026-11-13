import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtures } from './fixtures.mjs';

const fixtures = await createFixtures();
const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.png': 'image/png', '.wasm': 'application/wasm' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const root = pathname.startsWith('/fixtures/') ? fixtures : path.resolve('dist/webview');
    const relative = pathname.startsWith('/fixtures/') ? pathname.slice(10) : pathname === '/' ? 'index.html' : pathname.slice(1);
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(path.resolve(root) + path.sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(filename);
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
}).listen(4173, '127.0.0.1');
