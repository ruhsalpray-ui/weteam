'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./src/config');
const { open } = require('./src/db');
const auth = require('./src/auth');
const { AppError, runJobs } = require('./src/escrow');
const api = require('./src/api');
const { ensureAdmin, seedDemo } = require('./src/seed');
const { serveUpload } = require('./src/uploads');

const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 256 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

/* ---------------- router ---------------- */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}
api.register(route);

/* ---------------- util ---------------- */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(value, maxAge) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
}
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}
function readBody(req, maxBody = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBody) { reject(new AppError(413, 'Data yang dikirim terlalu besar.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      } catch (e) { reject(new AppError(400, 'Format data tidak valid.')); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  // Kalau di belakang reverse proxy (Nginx, Cloudflare), aktifkan TRUST_PROXY=1 supaya IP asli terbaca.
  if (process.env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '?';
}
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  if (++b.n > max) throw new AppError(429, 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.');
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60e3).unref();

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  file = path.normalize(path.join(PUBLIC, decodeURIComponent(file)));
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

function mockPayPage(db, ref, user) {
  const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!p || !user || p.user_id !== user.id) return '<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:24px">Pembayaran tidak ditemukan. <a href="/">Kembali</a></p>';
  const method = { qris: 'QRIS', va: 'Virtual account' }[p.method] || p.method;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulasi pembayaran</title><style>
body{font-family:system-ui,sans-serif;background:#F4F6FB;color:#151A30;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:#fff;border:1px solid #DCE0EC;border-radius:18px;padding:28px;max-width:420px;width:100%;text-align:center}
.tag{display:inline-block;background:#FFF1C7;color:#6B4B00;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px}
h1{font-size:30px;margin:14px 0 4px}p{color:#5B6180}button{width:100%;height:46px;border-radius:10px;border:0;font:700 15px system-ui;cursor:pointer;margin-top:10px}
.ok{background:#2D3FE0;color:#fff}.no{background:#ECEFF7;color:#151A30}</style></head><body><main>
<span class="tag">Mode simulasi</span><p>${esc(method)}, ${esc(p.purpose === 'topup' ? 'top up saldo' : 'pembayaran pesanan')}</p>
<h1>Rp ${p.amount.toLocaleString('id-ID')}</h1><p style="font-size:13px">${esc(p.ref)}</p>
${p.status === 'pending' ? `<button class="ok" data-r="paid">Simulasikan pembayaran berhasil</button><button class="no" data-r="failed">Batalkan pembayaran</button>` : `<p>Status: <b>${esc(p.status)}</b></p><button class="no" data-r="">Kembali ke Sapecc</button>`}
<p style="font-size:12px;margin-top:18px">Halaman ini hanya muncul saat PAYMENT_PROVIDER=mock. Di production, pembeli diarahkan ke Midtrans.</p>
</main><script>
document.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
  if (b.dataset.r) {
    b.disabled = true;
    await fetch('/api/payments/mock/${encodeURIComponent(p.ref)}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: b.dataset.r }) });
  }
  location.href = '/?pay=${encodeURIComponent(p.ref)}';
}));
</script></body></html>`;
}

/* ---------------- server ---------------- */
function createServer(db) {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    const cookies = parseCookies(req.headers.cookie);
    const ip = clientIp(req);
    let user = auth.sessionUser(db, cookies.sid);

    try {
      if (pathname.startsWith('/api/')) {
        const r = routes.find(x => x.method === req.method && x.re.test(pathname));
        if (!r) {
          const exists = routes.some(x => x.re.test(pathname));
          throw new AppError(exists ? 405 : 404, exists ? 'Metode tidak diizinkan.' : 'Endpoint tidak ditemukan.');
        }
        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          // Perlindungan CSRF: wajib JSON dan (kalau ada) Origin harus dari situs ini sendiri.
          if (!r.opts.webhook) {
            if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'Kirim data dalam format JSON.');
            const origin = req.headers.origin;
            if (origin) {
              let host = null;
              try { host = new URL(origin).host; } catch (e) { /* Origin "null" atau tidak valid */ }
              if (host !== req.headers.host) throw new AppError(403, 'Permintaan ditolak.');
            }
          }
          body = await readBody(req, r.opts.maxBody);
        }
        if (r.opts.auth && !user) throw new AppError(401, 'Masuk dulu untuk melanjutkan.');
        if (r.opts.auth === 'admin' && user.role !== 'admin') throw new AppError(403, 'Khusus admin.');
        const m = pathname.match(r.re);
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const setCookie = [];
        const ctx = {
          db, user, params, body, ip, req,
          query: Object.fromEntries(url.searchParams),
          limit: (name, max, windowMs) => rateLimit(`${name}:${ip}`, max, windowMs),
          login: u => {
            if (cookies.sid) auth.destroySession(db, cookies.sid);
            const s = auth.createSession(db, u.id);
            setCookie.push(sessionCookie(s.token, s.maxAge));
          },
          logout: () => { auth.destroySession(db, cookies.sid); setCookie.push(sessionCookie('', 0)); }
        };
        const result = await r.handler(ctx);
        return send(res, 200, result ?? { ok: true }, setCookie.length ? { 'Set-Cookie': setCookie } : {});
      }

      if (req.method === 'GET' && pathname.startsWith('/pay/mock/')) {
        return send(res, 200, mockPayPage(db, decodeURIComponent(pathname.slice('/pay/mock/'.length)), user));
      }
      if (req.method === 'GET' && pathname.startsWith('/uploads/') && serveUpload(res, pathname)) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
      if (req.method === 'GET' && !path.extname(pathname) && serveStatic(req, res, '/')) return;
      send(res, 404, 'Halaman tidak ditemukan.', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (err) {
      const status = err instanceof AppError || err.status ? err.status : 500;
      if (status >= 500) console.error(`[sapecc] ${req.method} ${pathname}`, err);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(err instanceof AppError) && !err.status ? 'Terjadi kesalahan di server. Coba lagi sebentar.' : err.message });
    }
  });
}

async function start() {
  const db = open(config.dbFile);
  await ensureAdmin(db);
  if (config.seedDemo && await seedDemo(db)) console.log('[sapecc] Data contoh dibuat. Akun penjual contoh: kedaidiamond / sapecc123');
  const server = createServer(db);
  const jobs = () => { try { runJobs(db); auth.purgeSessions(db); } catch (e) { console.error('[sapecc] job gagal', e); } };
  setInterval(jobs, 60e3).unref();
  jobs();
  server.listen(config.port, () => {
    console.log(`[sapecc] Berjalan di ${config.baseUrl} (port ${config.port}, pembayaran: ${config.payment.provider})`);
  });
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}

if (require.main === module) start().catch(err => { console.error(err); process.exit(1); });

module.exports = { createServer };
