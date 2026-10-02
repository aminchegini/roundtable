// Static server for the webview browser preview: npm run preview
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 5179);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(url.pathname === '/' ? '/scripts/preview.html' : url.pathname);
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'Content-Type': types[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`preview: http://localhost:${port}/`));
