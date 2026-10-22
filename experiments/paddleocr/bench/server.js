import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const port = Number(process.env.PORT || 8765);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? '/experiments/paddleocr/bench/index.html' : urlPath;
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/experiments/paddleocr/bench/`);
});
