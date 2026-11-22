// RA Gigs – zero-dependency local server (Node 18+).
// Serves the UI and forwards GraphQL requests to ra.co (browsers can't call it directly: CORS).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const RA_ENDPOINT = 'https://ra.co/graphql';
// Shared artist list, stored in a file next to the server (override with DATA_FILE).
const DATA = process.env.DATA_FILE || path.join(__dirname, 'artists.json');

// Optional shared password (set PASSWORD in the host's environment settings). Any username works.
const PASSWORD = process.env.PASSWORD;

const server = http.createServer(async (req, res) => {
  if (PASSWORD) {
    const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    if (given.split(':').slice(1).join(':') !== PASSWORD) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RA Gigs"' });
      res.end('Password required');
      return;
    }
  }
  if (req.url === '/api/artists' && req.method === 'GET') {
    let d = '[]';
    try { d = fs.readFileSync(DATA, 'utf8'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(d);
    return;
  }
  if (req.url === '/api/artists' && req.method === 'PUT') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        const list = JSON.parse(b);
        if (!Array.isArray(list)) throw new Error('not an array');
        fs.writeFileSync(DATA, JSON.stringify(list));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/gql') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const r = await fetch(RA_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://ra.co/',
            Origin: 'https://ra.co',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          },
          body,
        });
        const text = await r.text();
        if (!r.ok) console.log('RA responded', r.status, text.slice(0, 300));
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(text);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'Proxy error: ' + e.message }] }));
      }
    });
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`RA Gigs running on http://localhost:${PORT}`));
