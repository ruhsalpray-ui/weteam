'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash palsu dipakai saat email tidak ditemukan, supaya waktu respons tetap sama
// dan orang tidak bisa menebak email mana yang terdaftar.
let dummyHash = null;
async function verifyPassword(password, stored) {
  if (!stored) {
    dummyHash = dummyHash || await hashPassword('dummy-password');
    stored = dummyHash;
    await verifyPassword(password, stored);
    return false;
  }
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expiresAt, Date.now());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function sessionUser(db, token) {
  if (!token || token.length > 100) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now()) || null;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function purgeSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = { hashPassword, verifyPassword, createSession, sessionUser, destroySession, purgeSessions };
