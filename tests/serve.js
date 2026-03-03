/**
 * Static file server for running the Overprint Studio tests.
 * Serves the project root and rewrites CDN URLs to local node_modules copies
 * so tests work without internet access.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = 3987;

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.pdf':  'application/pdf',
  '.json': 'application/json',
  '.map':  'application/json',
};

// Map CDN URLs that appear in the HTML to local file paths
const CDN_REWRITES = {
  'https://unpkg.com/pako@2.1.0/dist/pako.min.js':
    'node_modules/pako/dist/pako.min.js',
  'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js':
    'node_modules/pdf-lib/dist/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js':
    'node_modules/pdfjs-dist/build/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js':
    'node_modules/pdfjs-dist/build/pdf.worker.min.js',
};

function servePage(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // For the main HTML file, rewrite CDN script src to local paths
  if (ext === '.html') {
    let html = fs.readFileSync(filePath, 'utf-8');
    for (const [cdn, local] of Object.entries(CDN_REWRITES)) {
      html = html.replace(cdn, '/' + local);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let reqPath = decodeURIComponent(url.pathname);

  // Default to the app HTML
  if (reqPath === '/') reqPath = '/overprint-studio.html';

  const filePath = path.join(ROOT, reqPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found: ' + reqPath);
      return;
    }
    servePage(res, filePath);
  });
});

server.listen(PORT, () => {
  console.log(`Test server running at http://localhost:${PORT}`);
});
