'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const cfg = config.payment;
const snapBase = () => cfg.midtransProduction ? 'https://app.midtrans.com/snap/v1' : 'https://app.sandbox.midtrans.com/snap/v1';
const apiBase = () => cfg.midtransProduction ? 'https://api.midtrans.com/v2' : 'https://api.sandbox.midtrans.com/v2';
const basicAuth = () => 'Basic ' + Buffer.from(cfg.midtransServerKey + ':').toString('base64');

// Metode di Sapecc -> kanal pembayaran di Midtrans Snap
const ENABLED = {
  qris: ['other_qris', 'gopay', 'shopeepay'],
  va: ['bca_va', 'bni_va', 'bri_va', 'permata_va', 'echannel', 'other_va']
};

function assertUsable() {
  if (cfg.provider === 'mock' && config.production && !cfg.allowMockInProduction) {
    throw Object.assign(new Error('Pembayaran simulasi tidak boleh dipakai di production. Set PAYMENT_PROVIDER=midtrans.'), { status: 500 });
  }
  if (cfg.provider === 'midtrans' && !cfg.midtransServerKey) {
    throw Object.assign(new Error('MIDTRANS_SERVER_KEY belum diisi.'), { status: 500 });
  }
}

/**
 * Membuat sesi pembayaran di gateway.
 * @returns {Promise<{redirectUrl: string}>}
 */
async function createPayment({ ref, amount, method, user, description }) {
  assertUsable();
  if (cfg.provider === 'mock') return { redirectUrl: `${config.baseUrl}/pay/mock/${encodeURIComponent(ref)}` };
  if (cfg.provider !== 'midtrans') throw Object.assign(new Error(`PAYMENT_PROVIDER "${cfg.provider}" tidak dikenal.`), { status: 500 });

  const body = {
    transaction_details: { order_id: ref, gross_amount: amount },
    item_details: [{ id: ref, price: amount, quantity: 1, name: String(description || 'Pembayaran Sapecc').slice(0, 50) }],
    customer_details: { first_name: user.name.slice(0, 50), email: user.email },
    enabled_payments: ENABLED[method],
    callbacks: { finish: `${config.baseUrl}/?pay=${encodeURIComponent(ref)}` },
    expiry: { unit: 'hours', duration: config.paymentExpireHours }
  };
  const res = await fetch(`${snapBase()}/transactions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: basicAuth() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.redirect_url) {
    const msg = Array.isArray(data.error_messages) ? data.error_messages.join('; ') : `status ${res.status}`;
    throw Object.assign(new Error(`Gagal membuat pembayaran Midtrans: ${msg}`), { status: 502 });
  }
  return { redirectUrl: data.redirect_url };
}

// SHA512(order_id + status_code + gross_amount + server_key), sesuai dokumentasi Midtrans.
function midtransSignature(orderId, statusCode, grossAmount, serverKey = cfg.midtransServerKey) {
  return crypto.createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${serverKey}`).digest('hex');
}

function mapStatus(n) {
  const s = n.transaction_status;
  if (s === 'settlement') return 'paid';
  if (s === 'capture') return n.fraud_status === 'accept' || !n.fraud_status ? 'paid' : 'pending';
  if (['deny', 'cancel', 'expire', 'failure'].includes(s)) return 'failed';
  return 'pending';
}

/**
 * Memverifikasi notifikasi (webhook) dari Midtrans.
 * 1) cocokkan signature_key, 2) tanya ulang status ke API Midtrans supaya tidak bisa dipalsukan.
 * @returns {Promise<{ref: string, status: 'paid'|'pending'|'failed', amount: number}>}
 */
async function verifyMidtransNotification(n) {
  if (!n || typeof n !== 'object' || !n.order_id || !n.signature_key) throw Object.assign(new Error('Notifikasi tidak lengkap.'), { status: 400 });
  const expected = midtransSignature(n.order_id, n.status_code, n.gross_amount);
  const a = Buffer.from(expected), b = Buffer.from(String(n.signature_key));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Signature tidak valid.'), { status: 403 });

  const res = await fetch(`${apiBase()}/${encodeURIComponent(n.order_id)}/status`, {
    headers: { Accept: 'application/json', Authorization: basicAuth() },
    signal: AbortSignal.timeout(15000)
  });
  const st = await res.json().catch(() => null);
  if (!res.ok || !st || st.order_id !== n.order_id) throw Object.assign(new Error('Gagal mengecek status ke Midtrans.'), { status: 502 });
  return { ref: st.order_id, status: mapStatus(st), amount: Number(st.gross_amount), raw: st };
}

module.exports = { createPayment, verifyMidtransNotification, midtransSignature, mapStatus, provider: () => cfg.provider };
