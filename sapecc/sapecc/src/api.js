'use strict';
const config = require('./config');
const { CATS, BOARDS, validSub } = require('./meta');
const { saveImage, removeImage } = require('./uploads');
const auth = require('./auth');
const payments = require('./payments');
const E = require('./escrow');
const { AppError } = E;

const DAY = 864e5;
const now = () => Date.now();
const str = (v, max = 1000) => String(v == null ? '' : v).trim().slice(0, max);
const mask = n => { n = String(n || ''); return n.length <= 3 ? n[0] + '**' : n.slice(0, 2) + '***' + n.slice(-1); };

/* ---------------- penyaji data ---------------- */
function publicUser(db, u) {
  if (!u) return null;
  const shop = db.prepare('SELECT slug, name FROM shops WHERE user_id = ?').get(u.id);
  return { username: u.username, name: u.name, email: u.email, role: u.role, balance: u.balance, shop: shop ? { slug: shop.slug, name: shop.name } : null };
}

function shopBadge(s, done) {
  if (s.badge === 'star') return 'star';
  return s.base_orders + done >= 1000 ? 'trusted' : s.badge === 'trusted' ? 'trusted' : 'new';
}

function productView(p, slug, sold24) {
  return {
    id: String(p.id), name: p.name, price: p.price, seller: slug, cat: p.cat, sub: p.sub, icon: p.icon, hue: p.hue,
    rating: Math.round(p.rating * 10) / 10, reviews: p.reviews, sold: p.sold, sold24: sold24 || 0,
    age: Math.floor((now() - p.created_at) / DAY), auto: !!p.auto, stock: p.stock, desc: p.description, terms: p.terms || '', image: p.image || null, k: p.keywords, active: !!p.active
  };
}

function catalog(db) {
  const shops = db.prepare(`SELECT s.*, u.username,
      (SELECT COUNT(*) FROM orders o WHERE o.seller_id = s.user_id AND o.status = 'completed') AS done
    FROM shops s JOIN users u ON u.id = s.user_id`).all();
  const sellers = {}; const slugById = {};
  for (const s of shops) {
    slugById[s.id] = s.slug;
    sellers[s.slug] = { name: s.name, username: s.username, badge: shopBadge(s, s.done), orders: s.base_orders + s.done,
      joined: String(new Date(s.created_at).getFullYear()), city: s.city || '-', resp: s.resp, hue: s.hue };
  }
  const sold24 = {};
  for (const r of db.prepare(`SELECT i.product_id AS pid, SUM(i.qty) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.paid_at > ? AND o.status IN ('held','shipped','completed') GROUP BY i.product_id`).all(now() - DAY)) sold24[r.pid] = r.n;
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all().map(p => productView(p, slugById[p.shop_id], sold24[p.id]));
  const apps = Object.fromEntries(db.prepare('SELECT key, image FROM app_icons').all().map(r => [r.key, r.image]));
  return { sellers, products, apps, config: { ...config.fees, autoReleaseHours: config.autoReleaseHours, paymentProvider: payments.provider() } };
}

function orderView(db, o, viewer) {
  const buyer = db.prepare('SELECT username, name FROM users WHERE id = ?').get(o.buyer_id);
  const seller = db.prepare('SELECT username, name FROM users WHERE id = ?').get(o.seller_id);
  const shop = db.prepare('SELECT slug, name FROM shops WHERE user_id = ?').get(o.seller_id);
  const reviewed = db.prepare('SELECT product_id FROM reviews WHERE order_id = ?').all(o.id).map(r => String(r.product_id));
  return {
    code: o.code, type: o.type, title: o.title, note: o.note, status: o.status,
    role: viewer.id === o.buyer_id ? 'buyer' : viewer.id === o.seller_id ? 'seller' : 'admin',
    buyer: { username: buyer.username, name: buyer.name },
    seller: { username: seller.username, name: shop ? shop.name : seller.name, shop: shop ? shop.slug : null },
    subtotal: o.subtotal, feeBuyer: o.fee_buyer, feeSeller: o.fee_seller, total: o.total, payout: o.payout,
    method: o.method, paymentRef: o.payment_ref, complaint: o.complaint, resolution: o.resolution,
    createdAt: o.created_at, paidAt: o.paid_at, shippedAt: o.shipped_at, completedAt: o.completed_at,
    autoReleaseAt: o.shipped_at ? o.shipped_at + config.autoReleaseHours * 3600e3 : null,
    items: db.prepare('SELECT product_id, name, price, qty, game_id FROM order_items WHERE order_id = ?').all(o.id)
      .map(i => ({ productId: i.product_id ? String(i.product_id) : null, name: i.name, price: i.price, qty: i.qty, gameId: i.game_id })),
    events: db.prepare('SELECT status, actor, note, created_at FROM order_events WHERE order_id = ? ORDER BY id').all(o.id)
      .map(e => ({ status: e.status, actor: e.actor, note: e.note, at: e.created_at })),
    reviewed
  };
}

function threadView(db, t) {
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(t.user_id);
  return {
    id: t.id, board: t.board, cat: t.cat, title: t.title, body: t.body, by: u.name, pinned: !!t.pinned, views: t.views,
    productId: t.product_id ? String(t.product_id) : null, createdAt: t.created_at,
    replies: db.prepare('SELECT r.body, r.created_at, u.name FROM replies r JOIN users u ON u.id = r.user_id WHERE r.thread_id = ? ORDER BY r.id').all(t.id)
      .map(r => ({ by: r.name, body: r.body, createdAt: r.created_at }))
  };
}

function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'toko';
}

// Membuat sesi pembayaran di gateway setelah data pesanan tersimpan.
async function startPayment(db, user, payment, description) {
  if (!payment) return null;
  try {
    const { redirectUrl } = await payments.createPayment({ ...payment, user, description });
    db.prepare('UPDATE payments SET redirect_url = ?, updated_at = ? WHERE ref = ?').run(redirectUrl, now(), payment.ref);
    return redirectUrl;
  } catch (err) {
    E.failPayment(db, payment.ref, 'Gagal membuat pembayaran');
    throw new AppError(err.status || 502, err.message || 'Gagal menghubungi payment gateway.');
  }
}

/* ---------------- rute ---------------- */
function register(route) {
  route('GET', '/api/health', () => ({ ok: true }));

  route('GET', '/api/catalog', ({ db }) => catalog(db));

  route('GET', '/api/products/:id/reviews', ({ db, params }) => ({
    reviews: db.prepare(`SELECT r.stars, r.body, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ? ORDER BY r.id DESC LIMIT 20`).all(Number(params.id))
      .map(r => ({ stars: r.stars, body: r.body, by: mask(r.name), createdAt: r.created_at }))
  }));

  route('GET', '/api/live', ({ db }) => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const lines = db.prepare(`SELECT o.code, o.title, o.total, o.status, o.paid_at, u.name FROM orders o JOIN users u ON u.id = o.buyer_id
      WHERE o.paid_at IS NOT NULL ORDER BY o.paid_at DESC LIMIT 5`).all()
      .map(r => ({ id: r.code, at: r.paid_at, buyer: mask(r.name), title: r.title, total: r.total, st: r.status === 'completed' ? 'done' : 'held' }));
    return {
      lines,
      count: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE paid_at >= ?').get(start.getTime()).n,
      held: db.prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status IN ('held','shipped','complained')").get().s
    };
  });

  /* ----- akun ----- */
  route('GET', '/api/me', ({ db, user }) => ({ user: publicUser(db, user) }));

  route('POST', '/api/auth/register', async ({ db, body, login, limit }) => {
    limit('auth', config.authRateLimit, 15 * 60e3);
    const name = str(body.name, 60), username = str(body.username, 30).toLowerCase(), email = str(body.email, 120).toLowerCase(), password = String(body.password || '');
    if (name.length < 2) throw new AppError(400, 'Isi nama minimal 2 huruf.');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new AppError(400, 'Username 3 sampai 20 karakter: huruf kecil, angka, atau garis bawah.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Format email belum benar.');
    if (password.length < 8 || password.length > 200) throw new AppError(400, 'Kata sandi minimal 8 karakter.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AppError(409, 'Email ini sudah terdaftar. Silakan masuk.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new AppError(409, 'Username sudah dipakai. Coba yang lain.');
    const hash = await auth.hashPassword(password);
    const r = db.prepare('INSERT INTO users (username, email, name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(username, email, name, hash, now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    login(user);
    return { user: publicUser(db, user) };
  });

  route('POST', '/api/auth/login', async ({ db, body, login, limit }) => {
    limit('auth', config.authRateLimit, 15 * 60e3);
    const id = str(body.email, 120).toLowerCase().replace(/^@/, '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(id, id);
    const ok = await auth.verifyPassword(String(body.password || ''), user && user.pass_hash);
    if (!user || !ok) throw new AppError(401, 'Email atau kata sandi salah.');
    login(user);
    return { user: publicUser(db, user) };
  });

  route('POST', '/api/auth/logout', ({ logout }) => { logout(); return { ok: true }; });

  /* ----- saldo ----- */
  route('GET', '/api/wallet', ({ db, user }) => ({
    balance: user.balance,
    ledger: db.prepare('SELECT amount, balance_after, kind, ref, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id),
    withdrawals: db.prepare('SELECT id, amount, bank, account_no, account_name, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id)
      .map(w => ({ ...w, account_no: '••••' + w.account_no.slice(-4) }))
  }), { auth: true });

  route('POST', '/api/wallet/topup', async ({ db, user, body }) => {
    const payment = E.createTopup(db, user, body.amount, body.method);
    const payUrl = await startPayment(db, user, payment, 'Top up saldo Sapecc');
    return { ref: payment.ref, amount: payment.amount, payUrl };
  }, { auth: true });

  route('POST', '/api/wallet/withdraw', ({ db, user, body }) => {
    E.requestWithdrawal(db, user, body);
    return { ok: true, balance: db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance };
  }, { auth: true });

  /* ----- pembayaran ----- */
  route('GET', '/api/payments/:ref', ({ db, user, params }) => {
    const p = db.prepare('SELECT ref, purpose, amount, method, status, redirect_url FROM payments WHERE ref = ? AND user_id = ?').get(params.ref, user.id);
    if (!p) throw new AppError(404, 'Pembayaran tidak ditemukan.');
    return { payment: p };
  }, { auth: true });

  // Webhook Midtrans. Atur "Payment Notification URL" di dashboard Midtrans ke BASE_URL/api/payments/notify
  route('POST', '/api/payments/notify', async ({ db, body }) => {
    if (payments.provider() !== 'midtrans') throw new AppError(404, 'Tidak tersedia.');
    const v = await payments.verifyMidtransNotification(body);
    if (!db.prepare('SELECT 1 FROM payments WHERE ref = ?').get(v.ref)) return { ok: true, ignored: true };
    if (v.status === 'paid') E.markPaid(db, v.ref, v.amount, v.raw);
    else if (v.status === 'failed') E.failPayment(db, v.ref, 'Pembayaran gagal, dibatalkan, atau kedaluwarsa');
    return { ok: true };
  }, { webhook: true });

  // Hanya untuk PAYMENT_PROVIDER=mock: mensimulasikan hasil pembayaran.
  route('POST', '/api/payments/mock/:ref', ({ db, body, params, user }) => {
    if (payments.provider() !== 'mock' || (config.production && !config.payment.allowMockInProduction)) throw new AppError(404, 'Tidak tersedia.');
    const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(params.ref);
    if (!p || p.user_id !== user.id) throw new AppError(404, 'Pembayaran tidak ditemukan.');
    if (body.result === 'paid') E.markPaid(db, p.ref, p.amount, { mock: true });
    else E.failPayment(db, p.ref, 'Pembayaran dibatalkan');
    return { ok: true };
  }, { auth: true });

  /* ----- pesanan ----- */
  route('POST', '/api/checkout', async ({ db, user, body }) => {
    const r = E.checkout(db, user, body.items, body.method);
    const payUrl = await startPayment(db, user, r.payment, r.orders.map(o => o.title).join(', '));
    return { orders: r.orders.map(o => o.code), payUrl, ref: r.payment ? r.payment.ref : null };
  }, { auth: true });

  route('GET', '/api/orders', ({ db, user, query }) => {
    const col = query.role === 'seller' ? 'seller_id' : 'buyer_id';
    return { orders: db.prepare(`SELECT * FROM orders WHERE ${col} = ? ORDER BY id DESC LIMIT 100`).all(user.id).map(o => orderView(db, o, user)) };
  }, { auth: true });

  const mine = (db, user, code) => {
    const o = E.mustOrder(db, code);
    if (o.buyer_id !== user.id && o.seller_id !== user.id && user.role !== 'admin') throw new AppError(404, 'Pesanan tidak ditemukan.');
    return o;
  };
  route('GET', '/api/orders/:code', ({ db, user, params }) => ({ order: orderView(db, mine(db, user, params.code), user) }), { auth: true });

  route('POST', '/api/orders/:code/pay', async ({ db, user, params, body }) => {
    const r = E.payOrder(db, user, params.code, body.method);
    const payUrl = await startPayment(db, user, r.payment, r.orders[0].title);
    return { payUrl, ref: r.payment ? r.payment.ref : null };
  }, { auth: true });

  const act = fn => ({ db, user, params, body }) => { fn(db, user, params.code, body); return { order: orderView(db, E.getOrder(db, params.code), user) }; };
  route('POST', '/api/orders/:code/ship', act((db, u, c, b) => E.shipOrder(db, u, c, b.note)), { auth: true });
  route('POST', '/api/orders/:code/confirm', act((db, u, c) => E.confirmOrder(db, u, c)), { auth: true });
  route('POST', '/api/orders/:code/complain', act((db, u, c, b) => E.complainOrder(db, u, c, b.reason)), { auth: true });
  route('POST', '/api/orders/:code/cancel', act((db, u, c) => E.cancelOrder(db, u, c)), { auth: true });
  route('POST', '/api/orders/:code/review', act((db, u, c, b) => E.addReview(db, u, c, b.productId, b.stars, b.body)), { auth: true });

  route('POST', '/api/rekber', ({ db, user, body }) => ({ order: orderView(db, E.createRekber(db, user, body), user) }), { auth: true });

  /* ----- toko ----- */
  route('GET', '/api/shop', ({ db, user }) => {
    const shop = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(user.id);
    if (!shop) return { shop: null, products: [] };
    return {
      shop: { slug: shop.slug, name: shop.name, city: shop.city },
      products: db.prepare('SELECT * FROM products WHERE shop_id = ? ORDER BY id DESC').all(shop.id).map(p => productView(p, shop.slug, 0))
    };
  }, { auth: true });

  route('POST', '/api/shop', ({ db, user, body }) => {
    if (db.prepare('SELECT 1 FROM shops WHERE user_id = ?').get(user.id)) throw new AppError(409, 'Kamu sudah punya toko.');
    const name = str(body.name, 40), city = str(body.city, 40);
    if (name.length < 3) throw new AppError(400, 'Nama toko minimal 3 karakter.');
    let slug = slugify(name), i = 1;
    while (db.prepare('SELECT 1 FROM shops WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${++i}`;
    db.prepare('INSERT INTO shops (user_id, slug, name, city, hue, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, slug, name, city, Math.floor(Math.random() * 360), now());
    return { shop: { slug, name, city } };
  }, { auth: true });

  function readProduct(body, partial) {
    const out = {};
    if (!partial || body.name !== undefined) { out.name = str(body.name, 100); if (out.name.length < 5) throw new AppError(400, 'Nama produk minimal 5 karakter.'); }
    if (!partial || body.price !== undefined) { out.price = Number(body.price); if (!Number.isInteger(out.price) || out.price < 1000 || out.price > 100000000) throw new AppError(400, 'Harga antara Rp 1.000 dan Rp 100.000.000.'); }
    if (!partial || body.cat !== undefined) {
      out.cat = str(body.cat, 20); out.sub = str(body.sub, 30);
      if (!validSub(out.cat, out.sub)) throw new AppError(400, 'Kategori tidak valid.');
    }
    if (!partial || body.description !== undefined) { out.description = str(body.description, 2000); if (out.description.length < 10) throw new AppError(400, 'Deskripsi minimal 10 karakter.'); }
    if (!partial || body.stock !== undefined) { out.stock = body.stock === '' || body.stock == null ? -1 : Number(body.stock); if (!Number.isInteger(out.stock) || out.stock < -1 || out.stock > 1000000) throw new AppError(400, 'Stok tidak valid.'); }
    if (!partial || body.icon !== undefined) out.icon = str(body.icon, 8) || '📦';
    if (!partial || body.auto !== undefined) out.auto = body.auto ? 1 : 0;
    if (!partial || body.keywords !== undefined) out.keywords = str(body.keywords, 200);
    if (!partial || body.terms !== undefined) out.terms = str(body.terms, 4000);
    if (body.active !== undefined) out.active = body.active ? 1 : 0;
    return out;
  }
  const myShop = (db, user) => {
    const s = db.prepare('SELECT * FROM shops WHERE user_id = ?').get(user.id);
    if (!s) throw new AppError(400, 'Buka toko dulu sebelum menambah produk.');
    return s;
  };
  route('POST', '/api/shop/products', ({ db, user, body }) => {
    const s = myShop(db, user); const p = readProduct(body, false);
    const r = db.prepare(`INSERT INTO products (shop_id, name, price, cat, sub, icon, hue, description, terms, keywords, auto, stock, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, p.name, p.price, p.cat, p.sub, p.icon, s.hue, p.description, p.terms, p.keywords, p.auto, p.stock, now());
    return { id: String(r.lastInsertRowid) };
  }, { auth: true });

  route('PATCH', '/api/shop/products/:id', ({ db, user, params, body }) => {
    const s = myShop(db, user);
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND shop_id = ?').get(Number(params.id), s.id);
    if (!p) throw new AppError(404, 'Produk tidak ditemukan di tokomu.');
    const f = readProduct(body, true); const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE products SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), p.id);
    return { ok: true };
  }, { auth: true });

  /* ----- diskusi & forum ----- */
  route('GET', '/api/boards/:board', ({ db, params }) => {
    if (!BOARDS[params.board]) throw new AppError(404, 'Papan tidak ditemukan.');
    return { threads: db.prepare('SELECT * FROM threads WHERE board = ? ORDER BY pinned DESC, id DESC LIMIT 100').all(params.board).map(t => threadView(db, t)) };
  });
  route('POST', '/api/boards/:board/threads', ({ db, user, params, body, limit }) => {
    limit('post', 20, 60 * 60e3);
    const cats = BOARDS[params.board];
    if (!cats) throw new AppError(404, 'Papan tidak ditemukan.');
    const cat = str(body.cat, 20), title = str(body.title, 120), text = str(body.body, 2000);
    if (!cats.includes(cat) || (cat === 'info' && user.role !== 'admin')) throw new AppError(400, 'Kategori tidak valid.');
    if (title.length < 5) throw new AppError(400, 'Judul minimal 5 karakter.');
    if (text.length < 5) throw new AppError(400, 'Isi topik minimal 5 karakter.');
    const r = db.prepare('INSERT INTO threads (board, cat, title, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(params.board, cat, title, text, user.id, now());
    return { thread: threadView(db, db.prepare('SELECT * FROM threads WHERE id = ?').get(r.lastInsertRowid)) };
  }, { auth: true });
  route('POST', '/api/threads/:id/replies', ({ db, user, params, body, limit }) => {
    limit('post', 20, 60 * 60e3);
    const t = db.prepare('SELECT id FROM threads WHERE id = ?').get(Number(params.id));
    if (!t) throw new AppError(404, 'Topik tidak ditemukan.');
    const text = str(body.body, 1000);
    if (!text) throw new AppError(400, 'Balasan tidak boleh kosong.');
    db.prepare('INSERT INTO replies (thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(t.id, user.id, text, now());
    return { reply: { by: user.name, body: text, createdAt: now() } };
  }, { auth: true });
  route('POST', '/api/threads/:id/view', ({ db, params }) => {
    db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  /* ----- pesan (chat) ----- */
  route('GET', '/api/conversations', ({ db, user }) => ({
    conversations: db.prepare(`SELECT u.username, u.name, m.body, m.created_at,
        (SELECT COUNT(*) FROM messages x WHERE x.from_id = u.id AND x.to_id = ? AND x.read_at IS NULL) AS unread
      FROM messages m JOIN users u ON u.id = CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END
      WHERE m.id IN (SELECT MAX(id) FROM messages WHERE from_id = ? OR to_id = ? GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)
      ORDER BY m.id DESC LIMIT 50`).all(user.id, user.id, user.id, user.id, user.id)
  }), { auth: true });
  route('GET', '/api/messages', ({ db, user, query }) => {
    const other = db.prepare('SELECT id, username, name FROM users WHERE username = ?').get(str(query.with, 30).toLowerCase());
    if (!other) throw new AppError(404, 'Pengguna tidak ditemukan.');
    db.prepare('UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL').run(now(), other.id, user.id);
    const shop = db.prepare('SELECT name FROM shops WHERE user_id = ?').get(other.id);
    return {
      with: { username: other.username, name: shop ? shop.name : other.name },
      messages: db.prepare(`SELECT from_id, body, created_at FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 100`)
        .all(user.id, other.id, other.id, user.id).reverse().map(m => ({ mine: m.from_id === user.id, body: m.body, at: m.created_at }))
    };
  }, { auth: true });
  route('POST', '/api/messages', ({ db, user, body, limit }) => {
    limit('msg', 60, 10 * 60e3);
    const other = db.prepare('SELECT id FROM users WHERE username = ?').get(str(body.to, 30).toLowerCase());
    if (!other) throw new AppError(404, 'Pengguna tidak ditemukan.');
    if (other.id === user.id) throw new AppError(400, 'Tidak bisa mengirim pesan ke diri sendiri.');
    const text = str(body.body, 1000);
    if (!text) throw new AppError(400, 'Pesan tidak boleh kosong.');
    db.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)').run(user.id, other.id, text, now());
    return { ok: true };
  }, { auth: true });

  /* ----- admin ----- */
  route('GET', '/api/admin/overview', ({ db, user }) => {
    const count = sql => db.prepare(sql).get().n;
    return {
      stats: {
        users: count('SELECT COUNT(*) AS n FROM users'),
        orders: count('SELECT COUNT(*) AS n FROM orders'),
        held: count("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status IN ('held','shipped','complained')"),
        balances: count('SELECT COALESCE(SUM(balance), 0) AS n FROM users'),
        complaints: count("SELECT COUNT(*) AS n FROM orders WHERE status = 'complained'"),
        withdrawals: count("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'")
      },
      complaints: db.prepare("SELECT * FROM orders WHERE status = 'complained' ORDER BY updated_at").all().map(o => orderView(db, o, user)),
      withdrawals: db.prepare(`SELECT w.*, u.username, u.name FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'pending' ORDER BY w.id`).all(),
      recent: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 30').all().map(o => orderView(db, o, user))
    };
  }, { auth: 'admin' });
  route('POST', '/api/admin/orders/:code/resolve', ({ db, user, params, body }) => {
    E.resolveComplaint(db, user, params.code, body.decision, body.note);
    return { ok: true };
  }, { auth: 'admin' });
  route('POST', '/api/admin/withdrawals/:id', ({ db, params, body }) => {
    E.processWithdrawal(db, params.id, body.action);
    return { ok: true };
  }, { auth: 'admin' });

  /* ----- admin: logo, deskripsi, dan S&K produk ----- */
  const UPLOAD = { auth: 'admin', maxBody: 1600 * 1024 };
  const adminProduct = (db, id) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    if (!p) throw new AppError(404, 'Produk tidak ditemukan.');
    return p;
  };
  route('GET', '/api/admin/products', ({ db }) => ({
    products: db.prepare('SELECT p.*, s.name AS shop_name, s.slug FROM products p JOIN shops s ON s.id = p.shop_id ORDER BY p.id DESC').all()
      .map(p => ({ id: String(p.id), name: p.name, shop: p.shop_name, slug: p.slug, price: p.price, cat: p.cat, sub: p.sub, hue: p.hue,
        icon: p.icon, image: p.image || null, description: p.description, terms: p.terms || '', active: !!p.active, sold: p.sold }))
  }), { auth: 'admin' });

  route('PATCH', '/api/admin/products/:id', ({ db, params, body }) => {
    const p = adminProduct(db, params.id); const f = {};
    if (body.name !== undefined) { f.name = str(body.name, 100); if (f.name.length < 5) throw new AppError(400, 'Nama produk minimal 5 karakter.'); }
    if (body.description !== undefined) { f.description = str(body.description, 4000); if (f.description.length < 10) throw new AppError(400, 'Deskripsi minimal 10 karakter.'); }
    if (body.terms !== undefined) f.terms = str(body.terms, 4000);
    if (body.icon !== undefined) f.icon = str(body.icon, 8) || '📦';
    if (body.active !== undefined) f.active = body.active ? 1 : 0;
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE products SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), p.id);
    return { ok: true };
  }, { auth: 'admin' });

  route('POST', '/api/admin/products/:id/image', ({ db, params, body }) => {
    const p = adminProduct(db, params.id);
    const image = body.remove ? null : saveImage(body.data);
    db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, p.id);
    removeImage(p.image);
    return { image };
  }, UPLOAD);

  route('GET', '/api/admin/apps', ({ db }) => {
    const icons = Object.fromEntries(db.prepare('SELECT key, image FROM app_icons').all().map(r => [r.key, r.image]));
    return {
      categories: Object.entries(CATS).map(([cid, c]) => ({
        id: cid, name: c.name,
        apps: Object.entries(c.subs).map(([sid, [name, emoji]]) => ({
          id: sid, name, emoji, image: icons[`${cid}/${sid}`] || null,
          products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE cat = ? AND sub = ?').get(cid, sid).n
        }))
      }))
    };
  }, { auth: 'admin' });

  route('POST', '/api/admin/apps/:cat/:sub/image', ({ db, params, body }) => {
    if (!validSub(params.cat, params.sub)) throw new AppError(404, 'Aplikasi tidak ditemukan.');
    const key = `${params.cat}/${params.sub}`;
    const old = db.prepare('SELECT image FROM app_icons WHERE key = ?').get(key);
    if (body.remove) db.prepare('DELETE FROM app_icons WHERE key = ?').run(key);
    else {
      const image = saveImage(body.data);
      db.prepare('INSERT INTO app_icons (key, image, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at')
        .run(key, image, now());
    }
    if (old) removeImage(old.image);
    return { image: body.remove ? null : db.prepare('SELECT image FROM app_icons WHERE key = ?').get(key).image };
  }, UPLOAD);
}

module.exports = { register, catalog, orderView };
