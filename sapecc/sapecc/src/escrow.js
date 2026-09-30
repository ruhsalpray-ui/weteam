'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const { tx } = require('./db');

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => Date.now();
const HOUR = 3600 * 1000;

function randomCode(n) {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(n)].map(b => ch[b % ch.length]).join('');
}
function datePart() {
  const d = new Date();
  return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
const newOrderCode = () => `SPC-${datePart()}-${randomCode(5)}`;
const newPaymentRef = () => `PAY-${datePart()}-${randomCode(8)}`;

/* ---------------- biaya ---------------- */
function rekberFee(amount) {
  const f = config.fees;
  return Math.min(f.rekberMax, Math.max(f.rekberMin, Math.round(amount * f.rekberPercent / 100)));
}
function methodFee(method, amount) {
  if (method === 'qris') return Math.round(amount * config.fees.qrisPercent / 100);
  if (method === 'va') return config.fees.va;
  return 0;
}
const commission = subtotal => Math.round(subtotal * config.fees.commissionPercent / 100);

/* ---------------- saldo ---------------- */
// Semua perubahan saldo lewat fungsi ini, sehingga selalu tercatat di tabel ledger.
function moveBalance(db, userId, amount, kind, ref) {
  const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  if (!u) throw new AppError(404, 'Pengguna tidak ditemukan.');
  const next = u.balance + amount;
  if (next < 0) throw new AppError(400, 'Saldo tidak cukup.');
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(next, userId);
  db.prepare('INSERT INTO ledger (user_id, amount, balance_after, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, amount, next, kind, ref || null, now());
  return next;
}

/* ---------------- pesanan ---------------- */
const getOrder = (db, code) => db.prepare('SELECT * FROM orders WHERE code = ?').get(String(code || ''));
function mustOrder(db, code) {
  const o = getOrder(db, code);
  if (!o) throw new AppError(404, 'Pesanan tidak ditemukan.');
  return o;
}
function addEvent(db, orderId, status, actor, note) {
  db.prepare('INSERT INTO order_events (order_id, status, actor, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, status, actor, note || null, now());
}
function setStatus(db, o, status, actor, note, extra = {}) {
  const cols = ['status = ?', 'updated_at = ?'];
  const vals = [status, now()];
  for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(o.id);
  db.prepare(`UPDATE orders SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  addEvent(db, o.id, status, actor, note);
  Object.assign(o, { status, updated_at: now() }, extra);
}
function restoreStock(db, o) {
  for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(o.id)) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock >= 0').run(it.qty, it.product_id);
  }
}
function insertOrder(db, f) {
  const t = now();
  const r = db.prepare(`INSERT INTO orders (code, type, buyer_id, seller_id, created_by, title, note, subtotal, fee_buyer, fee_seller, total, payout, method, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)`)
    .run(newOrderCode(), f.type, f.buyerId, f.sellerId, f.createdBy, f.title, f.note || '', f.subtotal, f.feeBuyer, f.feeSeller,
      f.subtotal + f.feeBuyer, f.subtotal - f.feeSeller, f.method || null, t, t);
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
  addEvent(db, o.id, 'awaiting_payment', f.createdBy === f.buyerId ? 'buyer' : 'seller', f.type === 'rekber' ? 'Transaksi rekber dibuat' : 'Pesanan dibuat');
  return o;
}

// Membayar satu atau beberapa pesanan milik pembeli (dipanggil di dalam transaksi).
function settle(db, buyer, orders, method) {
  const sum = orders.reduce((a, o) => a + o.total, 0);
  if (method === 'saldo') {
    moveBalance(db, buyer.id, -sum, 'purchase', orders.map(o => o.code).join(','));
    for (const o of orders) setStatus(db, o, 'held', 'buyer', 'Dibayar dengan saldo, dana ditahan rekber', { paid_at: now(), method: 'saldo' });
    return { orders, payment: null };
  }
  const fee = methodFee(method, sum);
  const ref = newPaymentRef();
  db.prepare(`INSERT INTO payments (ref, purpose, user_id, amount, fee, credit, method, provider, status, created_at, updated_at)
    VALUES (?, 'order', ?, ?, ?, 0, ?, ?, 'pending', ?, ?)`)
    .run(ref, buyer.id, sum + fee, fee, method, config.payment.provider, now(), now());
  for (const o of orders) db.prepare('UPDATE orders SET payment_ref = ?, method = ? WHERE id = ?').run(ref, method, o.id);
  return { orders, payment: { ref, amount: sum + fee, fee, method } };
}

const METHODS = ['saldo', 'qris', 'va'];
function checkout(db, buyer, items, method) {
  if (!METHODS.includes(method)) throw new AppError(400, 'Metode pembayaran tidak dikenal.');
  if (!Array.isArray(items) || !items.length) throw new AppError(400, 'Keranjang masih kosong.');
  if (items.length > 20) throw new AppError(400, 'Maksimal 20 barang per pembayaran.');
  return tx(db, () => {
    const bySeller = new Map();
    for (const it of items) {
      const pid = Number(it && it.productId);
      const qty = Number(it && it.qty);
      if (!Number.isInteger(pid) || !Number.isInteger(qty) || qty < 1 || qty > 100) throw new AppError(400, 'Data barang tidak valid.');
      const p = db.prepare(`SELECT p.*, s.user_id AS owner FROM products p JOIN shops s ON s.id = p.shop_id
        WHERE p.id = ? AND p.active = 1`).get(pid);
      if (!p) throw new AppError(404, 'Ada produk yang sudah tidak dijual. Hapus dari keranjang lalu coba lagi.');
      if (p.owner === buyer.id) throw new AppError(400, 'Kamu tidak bisa membeli produk dari tokomu sendiri.');
      const gameId = String(it.gameId || '').trim().slice(0, 64);
      if (p.cat === 'game' && gameId.length < 4) throw new AppError(400, `Isi ID pemain untuk ${p.name}.`);
      if (p.stock >= 0) {
        if (p.stock < qty) throw new AppError(409, `Stok ${p.name} tinggal ${p.stock}.`);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
      }
      if (!bySeller.has(p.owner)) bySeller.set(p.owner, []);
      bySeller.get(p.owner).push({ p, qty, gameId });
    }
    const orders = [];
    for (const [sellerId, list] of bySeller) {
      const subtotal = list.reduce((a, x) => a + x.p.price * x.qty, 0);
      const o = insertOrder(db, {
        type: 'order', buyerId: buyer.id, sellerId, createdBy: buyer.id,
        title: list[0].p.name + (list.length > 1 ? ` dan ${list.length - 1} lainnya` : ''),
        subtotal, feeBuyer: config.fees.service, feeSeller: commission(subtotal), method
      });
      for (const x of list) {
        db.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty, game_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(o.id, x.p.id, x.p.name, x.p.price, x.qty, x.gameId);
      }
      orders.push(o);
    }
    return settle(db, buyer, orders, method);
  });
}

function createRekber(db, user, input) {
  const role = input.role === 'seller' ? 'seller' : 'buyer';
  const payer = ['buyer', 'seller', 'split'].includes(input.payer) ? input.payer : 'buyer';
  const amount = Number(input.amount);
  const title = String(input.title || '').trim();
  const note = String(input.note || '').trim();
  const cpName = String(input.counterparty || '').trim().replace(/^@/, '').toLowerCase();
  if (!Number.isInteger(amount) || amount < 10000) throw new AppError(400, 'Nominal minimal Rp 10.000.');
  if (amount > 50000000) throw new AppError(400, 'Nominal maksimal Rp 50.000.000 per transaksi.');
  if (title.length < 3 || title.length > 120) throw new AppError(400, 'Nama barang atau jasa harus 3 sampai 120 karakter.');
  if (note.length > 300) throw new AppError(400, 'Catatan maksimal 300 karakter.');
  const cp = db.prepare('SELECT * FROM users WHERE username = ?').get(cpName);
  if (!cp) throw new AppError(404, `Username @${cpName || '-'} tidak ditemukan. Pastikan lawan transaksi sudah punya akun Sapecc.`);
  if (cp.id === user.id) throw new AppError(400, 'Tidak bisa membuat rekber dengan akunmu sendiri.');
  const fee = rekberFee(amount);
  const feeBuyer = payer === 'buyer' ? fee : payer === 'split' ? Math.ceil(fee / 2) : 0;
  return tx(db, () => insertOrder(db, {
    type: 'rekber', buyerId: role === 'buyer' ? user.id : cp.id, sellerId: role === 'buyer' ? cp.id : user.id,
    createdBy: user.id, title, note, subtotal: amount, feeBuyer, feeSeller: fee - feeBuyer
  }));
}

function payOrder(db, user, code, method) {
  if (!METHODS.includes(method)) throw new AppError(400, 'Metode pembayaran tidak dikenal.');
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.buyer_id !== user.id) throw new AppError(403, 'Hanya pembeli yang bisa membayar pesanan ini.');
    if (o.status !== 'awaiting_payment') throw new AppError(409, 'Pesanan ini sudah dibayar atau dibatalkan.');
    if (o.payment_ref) {
      db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE ref = ? AND status = 'pending'").run(now(), o.payment_ref);
    }
    return settle(db, user, [o], method);
  });
}

function createTopup(db, user, amount, method) {
  amount = Number(amount);
  if (!Number.isInteger(amount) || amount < 10000) throw new AppError(400, 'Nominal top up minimal Rp 10.000.');
  if (amount > 10000000) throw new AppError(400, 'Nominal top up maksimal Rp 10.000.000.');
  if (!['qris', 'va'].includes(method)) throw new AppError(400, 'Pilih QRIS atau virtual account.');
  const fee = methodFee(method, amount);
  const ref = newPaymentRef();
  db.prepare(`INSERT INTO payments (ref, purpose, user_id, amount, fee, credit, method, provider, status, created_at, updated_at)
    VALUES (?, 'topup', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(ref, user.id, amount + fee, fee, amount, method, config.payment.provider, now(), now());
  return { ref, amount: amount + fee, fee, method };
}

// Dipanggil saat gateway mengonfirmasi pembayaran. Aman dipanggil berkali-kali (idempoten).
function markPaid(db, ref, paidAmount, raw) {
  return tx(db, () => {
    const pay = db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref);
    if (!pay) throw new AppError(404, 'Pembayaran tidak ditemukan.');
    if (pay.status === 'paid') return { payment: pay, already: true };
    if (paidAmount != null && Math.round(Number(paidAmount)) !== pay.amount) {
      throw new AppError(400, 'Nominal pembayaran tidak cocok.');
    }
    db.prepare("UPDATE payments SET status = 'paid', raw = ?, updated_at = ? WHERE id = ?").run(raw ? JSON.stringify(raw).slice(0, 4000) : null, now(), pay.id);
    if (pay.purpose === 'topup') {
      moveBalance(db, pay.user_id, pay.credit, 'topup', pay.ref);
    } else {
      let refund = pay.amount;
      for (const o of db.prepare('SELECT * FROM orders WHERE payment_ref = ?').all(ref)) {
        if (o.status === 'awaiting_payment') {
          setStatus(db, o, 'held', 'system', 'Pembayaran diterima, dana ditahan rekber', { paid_at: now() });
          refund -= o.total;
        }
      }
      // Pembayaran masuk setelah pesanan kedaluwarsa atau dibatalkan: uangnya dikembalikan ke saldo.
      if (refund > 0 && refund !== pay.fee) moveBalance(db, pay.user_id, refund, 'refund', pay.ref);
    }
    return { payment: { ...pay, status: 'paid' }, already: false };
  });
}

function failPayment(db, ref, reason) {
  return tx(db, () => {
    const pay = db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref);
    if (!pay || pay.status !== 'pending') return;
    db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), pay.id);
    if (pay.purpose !== 'order') return;
    for (const o of db.prepare("SELECT * FROM orders WHERE payment_ref = ? AND status = 'awaiting_payment'").all(ref)) {
      if (o.type === 'order') {
        restoreStock(db, o);
        setStatus(db, o, 'cancelled', 'system', reason || 'Pembayaran gagal atau kedaluwarsa');
      } else {
        db.prepare('UPDATE orders SET payment_ref = NULL, updated_at = ? WHERE id = ?').run(now(), o.id);
      }
    }
  });
}

function releaseToSeller(db, o, actor, note) {
  moveBalance(db, o.seller_id, o.payout, 'payout', o.code);
  for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(o.id)) {
    db.prepare('UPDATE products SET sold = sold + ? WHERE id = ?').run(it.qty, it.product_id);
  }
  setStatus(db, o, 'completed', actor, note, { completed_at: now() });
}
function refundToBuyer(db, o, actor, note) {
  moveBalance(db, o.buyer_id, o.total, 'refund', o.code);
  restoreStock(db, o);
  setStatus(db, o, 'refunded', actor, note);
}

function shipOrder(db, user, code, note) {
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.seller_id !== user.id) throw new AppError(403, 'Hanya penjual yang bisa menandai pesanan terkirim.');
    if (o.status !== 'held') throw new AppError(409, 'Pesanan hanya bisa dikirim setelah dibayar.');
    setStatus(db, o, 'shipped', 'seller', String(note || '').trim().slice(0, 300) || 'Pesanan dikirim penjual', { shipped_at: now() });
    return o;
  });
}
function confirmOrder(db, user, code) {
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.buyer_id !== user.id) throw new AppError(403, 'Hanya pembeli yang bisa mengonfirmasi pesanan.');
    if (!['held', 'shipped'].includes(o.status)) throw new AppError(409, 'Pesanan ini tidak bisa dikonfirmasi.');
    releaseToSeller(db, o, 'buyer', 'Pembeli mengonfirmasi, dana diteruskan ke penjual');
    return o;
  });
}
function complainOrder(db, user, code, reason) {
  reason = String(reason || '').trim();
  if (reason.length < 10 || reason.length > 500) throw new AppError(400, 'Alasan komplain harus 10 sampai 500 karakter.');
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.buyer_id !== user.id) throw new AppError(403, 'Hanya pembeli yang bisa mengajukan komplain.');
    if (!['held', 'shipped'].includes(o.status)) throw new AppError(409, 'Komplain hanya bisa diajukan sebelum pesanan selesai.');
    setStatus(db, o, 'complained', 'buyer', reason, { complaint: reason });
    return o;
  });
}
function cancelOrder(db, user, code) {
  return tx(db, () => {
    const o = mustOrder(db, code);
    const isBuyer = o.buyer_id === user.id, isSeller = o.seller_id === user.id;
    if (!isBuyer && !isSeller) throw new AppError(403, 'Kamu tidak terlibat di pesanan ini.');
    if (o.status === 'awaiting_payment') {
      if (o.payment_ref) db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE ref = ? AND status = 'pending'").run(now(), o.payment_ref);
      restoreStock(db, o);
      setStatus(db, o, 'cancelled', isBuyer ? 'buyer' : 'seller', 'Dibatalkan sebelum dibayar');
    } else if (o.status === 'held' && isSeller) {
      refundToBuyer(db, o, 'seller', 'Penjual menolak pesanan, dana dikembalikan ke saldo pembeli');
    } else {
      throw new AppError(409, 'Pesanan ini tidak bisa dibatalkan lagi. Ajukan komplain kalau ada masalah.');
    }
    return o;
  });
}
function resolveComplaint(db, admin, code, decision, note) {
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.status !== 'complained') throw new AppError(409, 'Pesanan ini tidak sedang dikomplain.');
    const text = String(note || '').trim().slice(0, 500);
    if (decision === 'refund') refundToBuyer(db, o, 'admin', text || 'Admin mengembalikan dana ke pembeli');
    else if (decision === 'release') releaseToSeller(db, o, 'admin', text || 'Admin meneruskan dana ke penjual');
    else throw new AppError(400, 'Keputusan harus refund atau release.');
    db.prepare('UPDATE orders SET resolution = ? WHERE id = ?').run(text || decision, o.id);
    return o;
  });
}

function addReview(db, user, code, productId, stars, body) {
  stars = Number(stars); body = String(body || '').trim();
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new AppError(400, 'Pilih 1 sampai 5 bintang.');
  if (body.length > 500) throw new AppError(400, 'Ulasan maksimal 500 karakter.');
  return tx(db, () => {
    const o = mustOrder(db, code);
    if (o.buyer_id !== user.id) throw new AppError(403, 'Hanya pembeli yang bisa memberi ulasan.');
    if (o.status !== 'completed') throw new AppError(409, 'Ulasan bisa diberikan setelah pesanan selesai.');
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(o.id, Number(productId));
    if (!item) throw new AppError(404, 'Produk ini tidak ada di pesanan tersebut.');
    if (db.prepare('SELECT 1 FROM reviews WHERE order_id = ? AND product_id = ?').get(o.id, item.product_id)) throw new AppError(409, 'Kamu sudah memberi ulasan untuk produk ini.');
    db.prepare('INSERT INTO reviews (product_id, order_id, user_id, stars, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.product_id, o.id, user.id, stars, body, now());
    db.prepare('UPDATE products SET rating = ((rating * reviews) + ?) / (reviews + 1), reviews = reviews + 1 WHERE id = ?').run(stars, item.product_id);
  });
}

function requestWithdrawal(db, user, input) {
  const amount = Number(input.amount);
  const bank = String(input.bank || '').trim(), accountNo = String(input.accountNo || '').replace(/\s/g, ''), accountName = String(input.accountName || '').trim();
  if (!Number.isInteger(amount) || amount < 50000) throw new AppError(400, 'Penarikan minimal Rp 50.000.');
  if (bank.length < 2 || bank.length > 40) throw new AppError(400, 'Isi nama bank atau e-wallet.');
  if (!/^\d{5,20}$/.test(accountNo)) throw new AppError(400, 'Nomor rekening hanya angka, 5 sampai 20 digit.');
  if (accountName.length < 3 || accountName.length > 60) throw new AppError(400, 'Isi nama pemilik rekening.');
  return tx(db, () => {
    moveBalance(db, user.id, -amount, 'withdraw', null);
    const r = db.prepare('INSERT INTO withdrawals (user_id, amount, bank, account_no, account_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, amount, bank, accountNo, accountName, 'pending', now(), now());
    return r.lastInsertRowid;
  });
}
function processWithdrawal(db, id, action) {
  return tx(db, () => {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(Number(id));
    if (!w) throw new AppError(404, 'Permintaan penarikan tidak ditemukan.');
    if (w.status !== 'pending') throw new AppError(409, 'Permintaan ini sudah diproses.');
    if (action === 'paid') db.prepare("UPDATE withdrawals SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), w.id);
    else if (action === 'reject') {
      moveBalance(db, w.user_id, w.amount, 'withdraw_reject', `WD-${w.id}`);
      db.prepare("UPDATE withdrawals SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), w.id);
    } else throw new AppError(400, 'Aksi harus paid atau reject.');
  });
}

// Tugas berkala: cairkan dana otomatis dan batalkan pesanan yang tidak dibayar.
function runJobs(db) {
  const t = now();
  const releaseBefore = t - config.autoReleaseHours * HOUR;
  for (const o of db.prepare("SELECT * FROM orders WHERE status = 'shipped' AND shipped_at < ?").all(releaseBefore)) {
    tx(db, () => {
      const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
      if (fresh.status === 'shipped') releaseToSeller(db, fresh, 'system', `Tidak ada respons pembeli ${config.autoReleaseHours} jam, dana diteruskan otomatis`);
    });
  }
  const expireBefore = t - config.paymentExpireHours * HOUR;
  for (const p of db.prepare("SELECT ref FROM payments WHERE status = 'pending' AND created_at < ?").all(expireBefore)) failPayment(db, p.ref, 'Pembayaran kedaluwarsa');
  for (const o of db.prepare("SELECT * FROM orders WHERE status = 'awaiting_payment' AND payment_ref IS NULL AND created_at < ?").all(expireBefore)) {
    tx(db, () => { restoreStock(db, o); setStatus(db, o, 'cancelled', 'system', 'Tidak dibayar sampai batas waktu'); });
  }
}

module.exports = {
  AppError, rekberFee, methodFee, moveBalance, getOrder, mustOrder,
  checkout, createRekber, payOrder, createTopup, markPaid, failPayment,
  shipOrder, confirmOrder, complainOrder, cancelOrder, resolveComplaint, addReview,
  requestWithdrawal, processWithdrawal, runJobs
};
