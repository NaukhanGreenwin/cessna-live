'use strict';
// Cessna Live proxy.
// Adds CORS headers to public ADS-B JSON APIs so a static page can call them
// from the browser. No dependencies. Node 20+ (global fetch).

const http = require('http');

const PORT = Number(process.env.PORT) || 10000;
const CACHE_MS = Number(process.env.CACHE_MS) || 2000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 8000;
const USER_AGENT = 'cessna-live/1.0 (single-aircraft live tracker; https://github.com/NaukhanGreenwin/cessna-live)';

// Upstreams in priority order. Both return readsb-style JSON: { now, ac: [...] }.
const UPSTREAMS = [
  {
    name: 'adsb.lol',
    url: (kind, value) => ({
      reg: `https://api.adsb.lol/v2/reg/${value}`,
      hex: `https://api.adsb.lol/v2/hex/${value}`,
      callsign: `https://api.adsb.lol/v2/callsign/${value}`,
    })[kind],
  },
  {
    name: 'adsb.fi',
    url: (kind, value) => ({
      reg: `https://opendata.adsb.fi/api/v2/registration/${value}`,
      hex: `https://opendata.adsb.fi/api/v2/hex/${value}`,
      callsign: `https://opendata.adsb.fi/api/v2/callsign/${value}`,
    })[kind],
  },
];

const KINDS = ['reg', 'hex', 'callsign'];
const PARAM_RE = /^[A-Za-z0-9-]{2,12}$/;
const COOLDOWN_MS = Number(process.env.UPSTREAM_COOLDOWN_MS) || 60000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;

const cache = new Map();        // key -> { until, status, body, upstream }
const inflight = new Map();     // key -> Promise
const cooldownUntil = new Map(); // upstream name -> timestamp; a failing upstream is tried last for a while

function trip(name, retryAfter) {
  let ms = COOLDOWN_MS;
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) ms = Math.max(ms, ra * 1000);
  cooldownUntil.set(name, Date.now() + Math.min(ms, COOLDOWN_MAX_MS));
}

function upstreamOrder() {
  const now = Date.now();
  const healthy = UPSTREAMS.filter((u) => (cooldownUntil.get(u.name) || 0) <= now);
  const cooling = UPSTREAMS.filter((u) => (cooldownUntil.get(u.name) || 0) > now);
  return healthy.concat(cooling); // cooling upstreams stay available as a last resort
}

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'X-Upstream, X-Cache',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  }, extra || {});
}

function send(res, status, body, extra) {
  const headers = corsHeaders(extra);
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(body);
}

function normalize(j) {
  // adsb.fi returns `now` in seconds on some endpoints and milliseconds on others.
  let now = Number(j.now);
  if (Number.isFinite(now) && now < 1e11) now = Math.round(now * 1000);
  return { now, ac: j.ac, total: j.total != null ? j.total : j.ac.length, msg: j.msg || 'No error' };
}

async function fetchUpstream(kind, value) {
  const errors = [];
  for (const up of upstreamOrder()) {
    const url = up.url(kind, value);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (r.status === 200) {
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        if (j && Array.isArray(j.ac)) {
          cooldownUntil.delete(up.name);
          return { status: 200, body: JSON.stringify(normalize(j)), upstream: up.name };
        }
        errors.push(`${up.name}: unexpected body`);
        trip(up.name, null);
      } else {
        errors.push(`${up.name}: HTTP ${r.status}`);
        if (r.status === 429 || r.status === 403 || r.status >= 500) trip(up.name, r.headers.get('retry-after'));
      }
    } catch (e) {
      errors.push(`${up.name}: ${e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e)}`);
      trip(up.name, null);
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 502, body: JSON.stringify({ error: 'all upstreams failed', detail: errors }), upstream: 'none' };
}

async function handleLookup(res, kind, value) {
  const key = `${kind}:${value.toUpperCase()}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) {
    return send(res, hit.status, hit.body, { 'X-Upstream': hit.upstream, 'X-Cache': 'HIT' });
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetchUpstream(kind, value.toUpperCase()).then((r) => {
      cache.set(key, Object.assign({ until: Date.now() + (r.status === 200 ? CACHE_MS : 1000) }, r));
      inflight.delete(key);
      return r;
    }, (e) => {
      inflight.delete(key);
      throw e;
    });
    inflight.set(key, p);
  }
  const r = await p;
  return send(res, r.status, r.body, { 'X-Upstream': r.upstream, 'X-Cache': 'MISS' });
}

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
}, 30000).unref();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) {
      return send(res, 200,
        'Cessna Live proxy. Endpoints: /v2/reg/{REG}  /v2/hex/{HEX}  /v2/callsign/{CALLSIGN}  /health\n',
        { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (parts[0] === 'health') {
      return send(res, 200, JSON.stringify({ ok: true, time: Date.now() }));
    }
    if (parts[0] === 'v2' && parts.length === 3 && KINDS.includes(parts[1])) {
      let value;
      try { value = decodeURIComponent(parts[2]); } catch (e) { value = ''; }
      if (!PARAM_RE.test(value)) return send(res, 400, JSON.stringify({ error: 'bad parameter' }));
      return await handleLookup(res, parts[1], value);
    }
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: 'internal', detail: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`cessna-live proxy listening on ${PORT}`);
});
