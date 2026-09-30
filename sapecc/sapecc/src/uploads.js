'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { AppError } = require('./escrow');

const MAX_BYTES = 1024 * 1024; // 1 MB setelah diperkecil di browser
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const NAME_RE = /^[a-f0-9]{24}\.(png|jpg|webp)$/;

// Cek isi file (bukan cuma namanya) supaya hanya gambar asli yang tersimpan.
function detect(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Menyimpan gambar dari data URL base64, mengembalikan alamat /uploads/... */
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new AppError(400, 'Gambar harus PNG, JPG, atau WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new AppError(400, 'Gambar kosong.');
  if (buf.length > MAX_BYTES) throw new AppError(400, 'Ukuran gambar maksimal 1 MB.');
  const ext = detect(buf);
  if (!ext) throw new AppError(400, 'File ini bukan gambar yang valid.');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, name), buf);
  return `/uploads/${name}`;
}

function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const name = path.basename(url);
  if (!NAME_RE.test(name)) return;
  try { fs.unlinkSync(path.join(config.uploadDir, name)); } catch (e) { /* sudah tidak ada */ }
}

/** Mengirim file upload. Mengembalikan false kalau tidak ditemukan. */
function serveUpload(res, pathname) {
  const name = path.basename(decodeURIComponent(pathname));
  if (!NAME_RE.test(name)) return false;
  const file = path.join(config.uploadDir, name);
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return false; }
  res.writeHead(200, { 'Content-Type': TYPES[name.split('.').pop()], 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { saveImage, removeImage, serveUpload };
