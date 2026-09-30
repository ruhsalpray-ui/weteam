'use strict';
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const flag = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true');
const production = env.NODE_ENV === 'production';
const port = num(env.PORT, 3000);

module.exports = {
  port,
  production,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'sapecc.db'),
  uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  cookieSecure: flag(env.COOKIE_SECURE, production),
  seedDemo: flag(env.SEED_DEMO, !production),
  adminEmail: (env.ADMIN_EMAIL || '').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  payment: {
    provider: env.PAYMENT_PROVIDER || 'mock',
    midtransServerKey: env.MIDTRANS_SERVER_KEY || '',
    midtransProduction: flag(env.MIDTRANS_PRODUCTION, false),
    allowMockInProduction: flag(env.ALLOW_MOCK, false)
  },
  fees: {
    service: num(env.SERVICE_FEE, 1000),
    qrisPercent: num(env.QRIS_FEE_PERCENT, 0.7),
    va: num(env.VA_FEE, 2500),
    rekberPercent: num(env.REKBER_FEE_PERCENT, 2.5),
    rekberMin: num(env.REKBER_FEE_MIN, 2000),
    rekberMax: num(env.REKBER_FEE_MAX, 100000),
    commissionPercent: num(env.COMMISSION_PERCENT, 0)
  },
  // Batas percobaan masuk/daftar per IP dalam 15 menit
  authRateLimit: num(env.AUTH_RATE_LIMIT, 10),
  autoReleaseHours: num(env.AUTO_RELEASE_HOURS, 72),
  paymentExpireHours: num(env.PAYMENT_EXPIRE_HOURS, 24)
};
