'use strict';
// Uji alur utama lewat HTTP sungguhan: node --test test/
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.SEED_DEMO = '1';
process.env.ADMIN_EMAIL = 'admin@uji.test';
process.env.ADMIN_PASSWORD = 'sandi-admin-uji';
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.UPLOAD_DIR = require('node:path').join(require('node:os').tmpdir(), 'sapecc-uji-upload');

const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { ensureAdmin, seedDemo } = require('../src/seed');
const { createServer } = require('../server');
const { midtransSignature } = require('../src/payments');
const { runJobs } = require('../src/escrow');
const config = require('../src/config');

let server, base, db;

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}
async function payMock(call, ref, result = 'paid') {
  const r = await call('POST', `/api/payments/mock/${ref}`, { result });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test.before(async () => {
  db = open(':memory:');
  await ensureAdmin(db);
  await seedDemo(db);
  server = createServer(db);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('alur lengkap: daftar, top up, beli, kirim, konfirmasi, dana cair', async () => {
  const buyer = client(), seller = client();
  let r = await buyer('POST', '/api/auth/register', { name: 'Budi', username: 'budi', email: 'budi@uji.test', password: 'rahasia123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const cat = (await buyer('GET', '/api/catalog')).data;
  const ff = cat.products.find(p => p.name === 'Free Fire 140 diamond');
  assert.ok(ff);

  r = await buyer('POST', '/api/checkout', { items: [{ productId: ff.id, qty: 2, gameId: '12345678' }], method: 'saldo' });
  assert.equal(r.status, 400, 'saldo masih nol');

  r = await buyer('POST', '/api/checkout', { items: [{ productId: ff.id, qty: 1 }], method: 'saldo' });
  assert.equal(r.status, 400, 'produk game wajib ID pemain');

  r = await buyer('POST', '/api/wallet/topup', { amount: 100000, method: 'qris' });
  assert.equal(r.status, 200);
  assert.match(r.data.payUrl, /\/pay\/mock\//);
  await payMock(buyer, r.data.ref);
  await payMock(buyer, r.data.ref); // notifikasi ganda tidak boleh menambah saldo dua kali
  assert.equal((await buyer('GET', '/api/me')).data.user.balance, 100000);

  r = await buyer('POST', '/api/checkout', { items: [{ productId: ff.id, qty: 2, gameId: '12345678 (2011)' }], method: 'saldo' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const code = r.data.orders[0];
  const expectedTotal = ff.price * 2 + config.fees.service;
  assert.equal((await buyer('GET', '/api/me')).data.user.balance, 100000 - expectedTotal);

  r = await seller('POST', '/api/auth/login', { email: 'kedaidiamond', password: 'sapecc123' });
  assert.equal(r.status, 200);
  const before = (await seller('GET', '/api/me')).data.user.balance;
  r = await buyer('POST', `/api/orders/${code}/ship`, {});
  assert.equal(r.status, 403, 'pembeli tidak boleh menandai terkirim');
  r = await seller('POST', `/api/orders/${code}/ship`, { note: 'Diamond sudah masuk' });
  assert.equal(r.data.order.status, 'shipped');
  r = await buyer('POST', `/api/orders/${code}/confirm`, {});
  assert.equal(r.data.order.status, 'completed');
  assert.equal((await seller('GET', '/api/me')).data.user.balance, before + ff.price * 2);

  r = await buyer('POST', `/api/orders/${code}/review`, { productId: ff.id, stars: 5, body: 'Cepat banget' });
  assert.equal(r.status, 200);
  r = await buyer('POST', `/api/orders/${code}/review`, { productId: ff.id, stars: 5 });
  assert.equal(r.status, 409, 'ulasan hanya sekali');
});

test('rekber langsung, komplain, admin mengembalikan dana', async () => {
  const buyer = client(), seller = client(), admin = client();
  await buyer('POST', '/api/auth/register', { name: 'Citra', username: 'citra', email: 'citra@uji.test', password: 'rahasia123' });
  await seller('POST', '/api/auth/register', { name: 'Dodi', username: 'dodi', email: 'dodi@uji.test', password: 'rahasia123' });
  let r = await seller('POST', '/api/rekber', { role: 'seller', counterparty: '@citra', title: 'Desain banner', amount: 150000, payer: 'split' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = r.data.order;
  assert.equal(o.total, 150000 + 1875);
  assert.equal(o.payout, 150000 - 1875);

  r = await seller('POST', `/api/orders/${o.code}/pay`, { method: 'qris' });
  assert.equal(r.status, 403, 'penjual tidak bisa membayar');
  r = await buyer('POST', `/api/orders/${o.code}/pay`, { method: 'va' });
  assert.equal(r.status, 200);
  await payMock(buyer, r.data.ref);
  assert.equal((await buyer('GET', `/api/orders/${o.code}`)).data.order.status, 'held');

  r = await buyer('POST', `/api/orders/${o.code}/complain`, { reason: 'File yang dikirim tidak sesuai brief.' });
  assert.equal(r.data.order.status, 'complained');
  r = await buyer('POST', `/api/admin/orders/${o.code}/resolve`, { decision: 'refund' });
  assert.equal(r.status, 403);
  await admin('POST', '/api/auth/login', { email: 'admin@uji.test', password: 'sandi-admin-uji' });
  assert.equal((await admin('GET', '/api/admin/overview')).data.complaints.length, 1);
  r = await admin('POST', `/api/admin/orders/${o.code}/resolve`, { decision: 'refund', note: 'Bukti dari pembeli jelas' });
  assert.equal(r.status, 200);
  assert.equal((await buyer('GET', '/api/me')).data.user.balance, o.total);
});

test('pembayaran gagal membatalkan pesanan dan mengembalikan stok', async () => {
  const buyer = client();
  await buyer('POST', '/api/auth/register', { name: 'Eka', username: 'eka', email: 'eka@uji.test', password: 'rahasia123' });
  const p = (await buyer('GET', '/api/catalog')).data.products.find(x => x.stock > 0);
  let r = await buyer('POST', '/api/checkout', { items: [{ productId: p.id, qty: 2, gameId: 'ABCD1234' }], method: 'qris' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stockAfter = (await buyer('GET', '/api/catalog')).data.products.find(x => x.id === p.id).stock;
  assert.equal(stockAfter, p.stock - 2);
  await payMock(buyer, r.data.ref, 'failed');
  assert.equal((await buyer('GET', `/api/orders/${r.data.orders[0]}`)).data.order.status, 'cancelled');
  assert.equal((await buyer('GET', '/api/catalog')).data.products.find(x => x.id === p.id).stock, p.stock);
});

test('dana otomatis cair setelah batas waktu', async () => {
  const buyer = client(), seller = client();
  await buyer('POST', '/api/auth/register', { name: 'Fani', username: 'fani', email: 'fani@uji.test', password: 'rahasia123' });
  await seller('POST', '/api/auth/login', { email: 'rumahtemplate', password: 'sapecc123' });
  let r = await buyer('POST', '/api/wallet/topup', { amount: 50000, method: 'va' });
  await payMock(buyer, r.data.ref);
  const p = (await buyer('GET', '/api/catalog')).data.products.find(x => x.seller === 'rumah-template');
  r = await buyer('POST', '/api/checkout', { items: [{ productId: p.id, qty: 1 }], method: 'saldo' });
  const code = r.data.orders[0];
  await seller('POST', `/api/orders/${code}/ship`, {});
  db.prepare('UPDATE orders SET shipped_at = ? WHERE code = ?').run(Date.now() - (config.autoReleaseHours + 1) * 3600e3, code);
  runJobs(db);
  assert.equal((await buyer('GET', `/api/orders/${code}`)).data.order.status, 'completed');
});

test('keamanan: CSRF, akses, dan validasi', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { name: 'Gita', username: 'gita', email: 'gita@uji.test', password: 'rahasia123' });
  let res = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415, 'wajib JSON');
  res = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://situs-jahat.example' }, body: '{}' });
  assert.equal(res.status, 403, 'origin asing ditolak');
  assert.equal((await client()('GET', '/api/orders')).status, 401);
  assert.equal((await c('GET', '/api/admin/overview')).status, 403);
  assert.equal((await c('POST', '/api/auth/login', { email: 'gita', password: 'salah-sandi' })).status, 401);
  assert.equal((await c('POST', '/api/rekber', { role: 'buyer', counterparty: 'tidakada', title: 'Tes', amount: 20000 })).status, 404);
  const other = (await c('GET', '/api/orders/SPC-000000-XXXXX'));
  assert.equal(other.status, 404);
});

test('tanda tangan notifikasi Midtrans sesuai rumus SHA512', () => {
  const sig = midtransSignature('PAY-1', '200', '100000.00', 'kunci');
  const crypto = require('node:crypto');
  assert.equal(sig, crypto.createHash('sha512').update('PAY-1200100000.00kunci').digest('hex'));
});

test('admin mengatur logo, deskripsi, dan S&K produk', async () => {
  const admin = client(), user = client();
  await admin('POST', '/api/auth/login', { email: 'admin@uji.test', password: 'sandi-admin-uji' });
  await user('POST', '/api/auth/register', { name: 'Hana', username: 'hana', email: 'hana@uji.test', password: 'rahasia123' });
  const p = (await admin('GET', '/api/admin/products')).data.products.find(x => x.cat === 'game');
  assert.ok(p.terms.length > 0, 'data contoh punya S&K');
  assert.equal((await user('PATCH', `/api/admin/products/${p.id}`, { terms: 'x' })).status, 403, 'bukan admin ditolak');

  let r = await admin('PATCH', `/api/admin/products/${p.id}`, { description: 'Deskripsi baru yang lebih jelas.', terms: '- Aturan satu\n- Aturan dua', icon: '🎮' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('PATCH', `/api/admin/products/${p.id}`, { description: 'pendek' })).status, 400);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  r = await admin('POST', `/api/admin/products/${p.id}/image`, { data: png });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.image, /^\/uploads\/[a-f0-9]{24}\.png$/);
  const img = await fetch(base + r.data.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const fake = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.equal((await admin('POST', `/api/admin/products/${p.id}/image`, { data: fake })).status, 400, 'file palsu ditolak');
  assert.equal((await admin('POST', '/api/admin/apps/game/roblox/image', { data: png })).status, 200);
  assert.equal((await admin('POST', '/api/admin/apps/game/tidakada/image', { data: png })).status, 404);

  const cat = (await user('GET', '/api/catalog')).data;
  const cp = cat.products.find(x => x.id === p.id);
  assert.equal(cp.terms, '- Aturan satu\n- Aturan dua');
  assert.equal(cp.desc, 'Deskripsi baru yang lebih jelas.');
  assert.equal(cp.icon, '🎮');
  assert.ok(cp.image);
  assert.ok(cat.apps['game/roblox']);
  const apps = (await admin('GET', '/api/admin/apps')).data.categories;
  assert.ok(apps.find(c => c.id === 'game').apps.find(a => a.id === 'roblox').image);

  r = await admin('POST', `/api/admin/products/${p.id}/image`, { remove: true });
  assert.equal(r.data.image, null);
  assert.equal((await fetch(base + cp.image)).status, 404, 'file lama dihapus');
});
