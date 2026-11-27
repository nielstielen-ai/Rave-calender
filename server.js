// RA Gigs – zero-dependency server (Node 18+).
// Serves the UI, proxies artist search to ra.co, stores the shared artist list,
// and keeps a cache of every artist's upcoming gigs that it refreshes slowly in the background.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const RA_ENDPOINT = process.env.RA_ENDPOINT || 'https://ra.co/graphql';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'artists.json');
const GIGS_FILE = path.join(path.dirname(DATA), 'gigs.json');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PASSWORD = process.env.PASSWORD; // optional shared password, any username works
const REFRESH_KEY = process.env.REFRESH_KEY; // optional key so a scheduler can call /api/refresh without the password
const STALE_MS = 12 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- storage: Upstash Redis when configured, otherwise local files ---------- */
async function load(key, file, fallback) {
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(UP_URL + '/get/' + key, { headers: { Authorization: 'Bearer ' + UP_TOKEN } });
    if (!r.ok) throw new Error('Upstash ' + r.status);
    const j = await r.json();
    return j.result || fallback;
  }
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}
async function save(key, file, json) {
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(UP_URL + '/set/' + key, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN }, body: json });
    if (!r.ok) throw new Error('Upstash ' + r.status);
    return;
  }
  fs.writeFileSync(file, json);
}
const loadList = () => load('artists', DATA, '[]');
const saveList = (json) => save('artists', DATA, json);

/* ---------- wishlist / tickets marks: { eventId: { s: 'wish' | 'bought', d: 'YYYY-MM-DD' } } ---------- */
const MARKS_FILE = path.join(path.dirname(DATA), 'marks.json');
let marksLock = Promise.resolve();
const withLock = (fn) => { const p = marksLock.then(fn); marksLock = p.catch(() => {}); return p; };
async function loadMarks() {
  const raw = await load('marks', MARKS_FILE, '{}'); // errors propagate so a failed read never overwrites saved marks
  try { const m = JSON.parse(raw); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
}

/* ---------- talking to RA ---------- */
const RA_HEADERS = {
  'Content-Type': 'application/json',
  Referer: 'https://ra.co/',
  Origin: 'https://ra.co',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
async function ra(query, variables) {
  const r = await fetch(RA_ENDPOINT, { method: 'POST', headers: RA_HEADERS, body: JSON.stringify({ query, variables }) });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (!r.ok || j.errors) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'HTTP ' + r.status);
  return j.data;
}
async function raRetry(q, v) {
  try { return await ra(q, v); } catch { await sleep(1500); return ra(q, v); }
}

const FIELDS = 'id title date startTime contentUrl venue{name area{name country{name urlCode}}}';
const evQuery = (t) => `query A($id:ID!){artist(id:$id){events(limit:50,type:${t}){${FIELDS}}}}`;
const cutoff = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
function compact(e) {
  const area = e.venue && e.venue.area;
  const country = area && area.country;
  return {
    id: e.id,
    date: String(e.date || '').slice(0, 10),
    title: e.title,
    url: e.contentUrl ? 'https://ra.co' + e.contentUrl : '',
    venue: e.venue ? e.venue.name : '',
    city: area ? area.name : '',
    country: country ? country.name : '',
    cc: country ? country.urlCode : '',
  };
}
async function fetchArtistEvents(id) {
  const seen = new Map();
  let ok = false, firstErr;
  for (const t of ['FROMDATE', 'LATEST']) {
    try {
      const d = await raRetry(evQuery(t), { id });
      if (!d.artist) throw new Error('artist ' + id + ' not found');
      ok = true;
      for (const e of d.artist.events || []) if (!seen.has(e.id)) seen.set(e.id, e);
    } catch (e) { firstErr = firstErr || e; }
    await sleep(500);
  }
  if (!ok) throw firstErr;
  const min = cutoff();
  return [...seen.values()].map(compact).filter((g) => g.date >= min);
}

/* ---------- gig cache + background refresh ---------- */
let cache = null; // { updatedAt, gigs: {artistId: [gig]}, errors: {artistId: text} }
let running = false, runMode = null, queued = null, lastRun = 0;

async function getCache() {
  if (!cache) {
    try { cache = JSON.parse(await load('gigs', GIGS_FILE, 'null')); } catch { cache = null; }
    if (!cache || typeof cache !== 'object') cache = { updatedAt: 0, gigs: {}, errors: {} };
    cache.gigs = cache.gigs || {};
    cache.errors = cache.errors || {};
  }
  return cache;
}

// mode 'all' re-fetches every artist, 'missing' only artists that have no cached gigs yet.
async function refresh(mode) {
  if (running) {
    if (mode === 'all' && runMode === 'all') return;
    queued = queued === 'all' || mode === 'all' ? 'all' : 'missing';
    return;
  }
  running = true; runMode = mode; lastRun = Date.now();
  try {
    const artists = JSON.parse(await loadList());
    const c = await getCache();
    const ids = new Set(artists.map((a) => String(a.id)));
    for (const k of Object.keys(c.gigs)) if (!ids.has(k)) delete c.gigs[k];
    for (const k of Object.keys(c.errors)) if (!ids.has(k)) delete c.errors[k];
    if (mode === 'all') c.errors = {};
    let okCount = 0;
    for (const a of artists) {
      const id = String(a.id);
      if (mode === 'missing' && c.gigs[id]) continue;
      try { c.gigs[id] = await fetchArtistEvents(id); delete c.errors[id]; okCount++; }
      catch (e) { c.errors[id] = a.name + ': ' + e.message; }
      await sleep(600);
    }
    if (mode === 'all' && okCount > 0) c.updatedAt = Date.now();
    if (!c.updatedAt && okCount > 0) c.updatedAt = Date.now();
    await save('gigs', GIGS_FILE, JSON.stringify(c));
  } catch (e) {
    console.log('refresh failed:', e.message);
  } finally {
    running = false; runMode = null;
    if (queued) { const m = queued; queued = null; refresh(m); }
  }
}

// While the server is awake, refresh by itself when the data is old.
setInterval(async () => {
  try {
    const c = await getCache();
    if (!running && Date.now() - c.updatedAt > STALE_MS && Date.now() - lastRun > 10 * 60 * 1000) refresh('all');
  } catch {}
}, 30 * 60 * 1000).unref();

/* ---------- http ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const keyOk = REFRESH_KEY && u.pathname === '/api/refresh' && u.searchParams.get('key') === REFRESH_KEY;
  if (PASSWORD && !keyOk) {
    const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    if (given.split(':').slice(1).join(':') !== PASSWORD) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RA Gigs"' });
      res.end('Password required');
      return;
    }
  }

  if (u.pathname === '/api/artists' && req.method === 'GET') {
    try { json(res, 200, await loadList()); }
    catch (e) { console.log('loadList failed:', e.message); json(res, 502, { error: e.message }); }
    return;
  }
  if (u.pathname === '/api/artists' && req.method === 'PUT') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      try {
        const list = JSON.parse(b);
        if (!Array.isArray(list)) throw new Error('not an array');
        await saveList(JSON.stringify(list));
        json(res, 200, { ok: true });
        refresh('missing'); // fetch gigs for newly added artists in the background
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/marks' && req.method === 'GET') {
    try { json(res, 200, await loadMarks()); } catch (e) { json(res, 502, { error: e.message }); }
    return;
  }
  if (u.pathname === '/api/marks' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      try {
        const { id, state, date } = JSON.parse(b);
        if (!/^[\w-]{1,40}$/.test(String(id))) throw new Error('bad id');
        if (!['none', 'wish', 'bought'].includes(state)) throw new Error('bad state');
        if (state !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('bad date');
        const out = await withLock(async () => {
          const m = await loadMarks();
          if (state === 'none') delete m[id]; else m[id] = { s: state, d: date };
          const min = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10); // forget events from over two weeks ago
          for (const k of Object.keys(m)) if (!m[k] || !m[k].d || m[k].d < min) delete m[k];
          await save('marks', MARKS_FILE, JSON.stringify(m));
          return m;
        });
        json(res, 200, out);
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/gigs' && req.method === 'GET') {
    try {
      const c = await getCache();
      if (!running && Date.now() - c.updatedAt > STALE_MS && Date.now() - lastRun > 10 * 60 * 1000) refresh('all');
      json(res, 200, { updatedAt: c.updatedAt, gigs: c.gigs, errors: Object.values(c.errors), refreshing: running });
    } catch (e) { json(res, 502, { error: e.message }); }
    return;
  }
  if (u.pathname === '/api/refresh' && (req.method === 'POST' || req.method === 'GET')) {
    refresh('all');
    json(res, 200, { started: true });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/gql') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const r = await fetch(RA_ENDPOINT, { method: 'POST', headers: RA_HEADERS, body });
        const text = await r.text();
        if (!r.ok) console.log('RA responded', r.status, text.slice(0, 300));
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(text);
      } catch (e) {
        json(res, 502, { errors: [{ message: 'Proxy error: ' + e.message }] });
      }
    });
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`RA Gigs running on http://localhost:${PORT}`));
