// Мінімальний сервер без залежностей: роздає public/ і проксіює alerts.in.ua,
// щоб токен API не потрапляв у браузер.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.ALERTS_IN_UA_TOKEN || '';
const UPSTREAM_URL = 'https://api.alerts.in.ua/v1/alerts/active.json';
const CACHE_MS = 15_000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const cache = { body: null, fetchedAt: 0, lastModified: null, pending: null };

async function fetchUpstream() {
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };
  if (cache.lastModified && cache.body) headers['If-Modified-Since'] = cache.lastModified;

  const response = await fetch(UPSTREAM_URL, { headers, signal: AbortSignal.timeout(10_000) });
  if (response.status === 304 && cache.body) {
    cache.fetchedAt = Date.now();
    return cache.body;
  }
  if (!response.ok) throw new Error(`alerts.in.ua ${response.status}`);

  const data = await response.json();
  cache.body = JSON.stringify({ alerts: data.alerts || [], fetched_at: new Date().toISOString() });
  cache.lastModified = response.headers.get('last-modified');
  cache.fetchedAt = Date.now();
  return cache.body;
}

async function getAlerts() {
  if (cache.body && Date.now() - cache.fetchedAt < CACHE_MS) return cache.body;
  // Одночасні запити клієнтів чекають на один запит до alerts.in.ua (ліміти API).
  if (!cache.pending) cache.pending = fetchUpstream().finally(() => { cache.pending = null; });
  try {
    return await cache.pending;
  } catch (error) {
    if (cache.body) return cache.body; // краще трохи застарілі дані, ніж нічого
    throw error;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra,
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const content = await fs.readFile(filePath);
    send(res, 200, req.method === 'HEAD' ? undefined : content, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');

  if (pathname === '/api/alerts') {
    if (!TOKEN) return send(res, 503, JSON.stringify({ error: 'ALERTS_IN_UA_TOKEN не задано' }));
    try {
      return send(res, 200, await getAlerts(), undefined, { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error(error);
      return send(res, 502, JSON.stringify({ error: 'Джерело даних недоступне' }));
    }
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}`);
  if (!TOKEN) console.warn('Увага: ALERTS_IN_UA_TOKEN не задано, /api/alerts повертатиме 503.');
});
