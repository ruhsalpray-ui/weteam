'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const { tx } = require('./db');
const { hashPassword } = require('./auth');

const DAY = 864e5;
const now = () => Date.now();

// Akun admin dibuat dari ADMIN_EMAIL + ADMIN_PASSWORD. Di mode demo, kalau kosong, dipakai akun contoh.
async function ensureAdmin(db) {
  let email = config.adminEmail, password = config.adminPassword;
  if (!email || !password) {
    if (!config.seedDemo) { console.warn('[sapecc] ADMIN_EMAIL / ADMIN_PASSWORD belum diisi, akun admin tidak dibuat.'); return; }
    email = 'admin@sapecc.test'; password = 'admin12345';
    console.warn('[sapecc] Memakai akun admin demo admin@sapecc.test / admin12345. Ganti lewat .env sebelum online.');
  }
  if (password.length < 8) console.warn('[sapecc] ADMIN_PASSWORD terlalu pendek, pakai minimal 12 karakter.');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) { db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id); return; }
  const hash = await hashPassword(password);
  let username = 'admin', i = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `admin${++i}`;
  db.prepare("INSERT INTO users (username, email, name, pass_hash, role, created_at) VALUES (?, ?, 'Admin Sapecc', ?, 'admin', ?)")
    .run(username, email, hash, now());
}

const SHOPS = [
  ['kedaidiamond', 'kedai-diamond', 'Kedai Diamond', 'trusted', 5840, 2022, 'Surabaya', '± 3 menit', 205],
  ['sinartopup', 'sinar-topup', 'Sinar Top Up', 'trusted', 3120, 2023, 'Bandung', '± 5 menit', 45],
  ['warungpixel', 'warung-pixel', 'Warung Pixel', 'star', 2470, 2023, 'Yogyakarta', '± 10 menit', 10],
  ['rumahtemplate', 'rumah-template', 'Rumah Template', 'trusted', 4390, 2022, 'Malang', '± 15 menit', 335],
  ['narastudio', 'nara-studio', 'Nara Studio', 'star', 1980, 2024, 'Denpasar', '± 20 menit', 290],
  ['cahayadigital', 'cahaya-digital', 'Cahaya Digital', 'trusted', 1350, 2024, 'Makassar', '± 10 menit', 180],
  ['bengkelkode', 'bengkel-kode', 'Bengkel Kode', 'new', 9, 2026, 'Jakarta', '± 1 jam', 240],
  ['lintangstore', 'lintang-store', 'Lintang Store', 'new', 0, 2026, 'Medan', '± 30 menit', 150]
];
// [nama, harga, slug toko, kategori, sub, ikon, hue, rating, jumlah ulasan, terjual, umur (hari), otomatis, stok (-1 = bebas), deskripsi, kata kunci]
const PRODUCTS = [
  ['Top up 86 diamond Mobile Legends', 21500, 'kedai-diamond', 'game', 'mobile-legends', '💎', 205, 4.9, 812, 5320, 120, 1, -1, 'Diamond masuk langsung ke akunmu lewat ID dan server. Bisa dipakai untuk skin, hero, atau Starlight.', 'ml mlbb dm'],
  ['Weekly Diamond Pass Mobile Legends', 27500, 'sinar-topup', 'game', 'mobile-legends', '🗓️', 260, 4.9, 540, 2980, 90, 1, -1, 'Dapat diamond harian selama 7 hari plus poin bonus. Cocok buat yang main setiap hari.', 'ml mlbb wdp diamond'],
  ['Top up 257 diamond Mobile Legends', 68000, 'warung-pixel', 'game', 'mobile-legends', '💠', 190, 4.8, 301, 1655, 75, 1, -1, 'Paket menengah untuk beli skin Epic atau hero baru.', 'ml mlbb dm'],
  ['800 Robux lewat gift card resmi', 128000, 'warung-pixel', 'game', 'roblox', '🧱', 8, 5.0, 210, 1402, 60, 0, 40, 'Kode gift card resmi dikirim lewat chat. Tukarkan sendiri di situs resmi Roblox.', 'robux rbx'],
  ['Roblox Premium 450, satu bulan', 72000, 'lintang-store', 'game', 'roblox', '🎟️', 350, 0, 0, 0, 1, 0, 15, 'Langganan Premium satu bulan dengan 450 Robux. Diproses manual oleh penjual.', 'robux premium'],
  ['Valorant 1.000 VP', 119000, 'sinar-topup', 'game', 'valorant', '🎯', 352, 4.9, 188, 940, 110, 1, -1, 'Valorant Points masuk lewat Riot ID. Pastikan region akun Asia Pasifik.', 'vp riot'],
  ['PUBG Mobile 325 UC', 76000, 'kedai-diamond', 'game', 'pubg-mobile', '🪂', 38, 4.8, 265, 1210, 95, 1, -1, 'UC masuk lewat ID karakter. Bisa untuk Royale Pass atau crate.', 'uc pubgm'],
  ['Free Fire 140 diamond', 19500, 'kedai-diamond', 'game', 'free-fire', '🔥', 18, 5.0, 640, 4100, 130, 1, -1, 'Diamond Free Fire lewat ID pemain, masuk dalam hitungan menit.', 'ff dm'],
  ['Point Blank 1.200 PB Cash', 10500, 'cahaya-digital', 'game', 'point-blank', '🎖️', 140, 0, 0, 0, 2, 1, -1, 'PB Cash untuk senjata dan item. Masukkan ID akun saat checkout.', 'pb cash'],
  ['Genshin Impact: Blessing of the Welkin Moon', 76000, 'warung-pixel', 'game', 'genshin-impact', '🌙', 230, 5.0, 156, 870, 80, 1, -1, 'Primogem harian selama 30 hari. Masukkan UID dan server.', 'genshin welkin primogem'],
  ['Genshin Impact 980 Genesis Crystal', 239000, 'sinar-topup', 'game', 'genshin-impact', '✨', 280, 4.9, 74, 310, 45, 1, -1, 'Genesis Crystal lewat UID, termasuk bonus top up pertama kalau belum pernah.', 'genshin crystal'],
  ['Template undangan pernikahan digital, 50 desain', 25000, 'rumah-template', 'digital', 'template', '💌', 335, 4.9, 420, 2210, 70, 1, -1, 'Undangan versi web dan gambar untuk dibagikan lewat WhatsApp. Tinggal ganti nama, tanggal, dan foto.', 'undangan nikah wedding'],
  ['Template CV ATS-friendly untuk Word dan Canva', 12000, 'rumah-template', 'digital', 'template', '📄', 210, 4.8, 380, 1980, 150, 1, -1, 'Sepuluh desain CV yang terbaca sistem rekrutmen, tersedia dalam Bahasa Indonesia dan Inggris.', 'cv resume lamaran'],
  ['Template feed Instagram UMKM, 60 slide', 18000, 'nara-studio', 'digital', 'template', '🖼️', 300, 4.9, 145, 760, 40, 1, -1, 'Desain feed promo, testimoni, dan katalog. Bisa diedit di Canva.', 'instagram feed canva'],
  ['Template laporan keuangan Excel otomatis', 30000, 'lintang-store', 'digital', 'template', '📊', 150, 0, 0, 0, 0, 1, -1, 'Isi transaksi harian, laporan laba rugi dan arus kas terisi otomatis.', 'excel keuangan'],
  ['E-book: Jualan online dari nol', 35000, 'cahaya-digital', 'digital', 'ebook', '📘', 220, 0, 0, 0, 0, 1, -1, '120 halaman tentang riset produk, foto, harga, dan cara mendapat pembeli pertama.', 'ebook jualan'],
  ['Kelas video: edit video pakai HP', 49000, 'nara-studio', 'digital', 'ebook', '🎬', 12, 4.9, 98, 520, 55, 1, -1, '18 video singkat, dari dasar memotong klip sampai color grading sederhana.', 'kelas video edit'],
  ['Preset Lightroom nuansa film, 30 preset', 15000, 'nara-studio', 'digital', 'aset', '📷', 28, 4.8, 260, 1640, 100, 1, -1, 'Preset mobile dan desktop dengan warna hangat ala film analog.', 'preset lightroom foto'],
  ['Pack font tulisan tangan, lisensi komersial', 45000, 'rumah-template', 'digital', 'aset', '✍️', 45, 4.9, 66, 290, 65, 1, -1, '12 font tulisan tangan untuk logo, kemasan, dan konten. Boleh dipakai untuk usaha.', 'font huruf'],
  ['500 sound effect untuk konten YouTube', 20000, 'lintang-store', 'digital', 'aset', '🎧', 265, 0, 0, 0, 1, 1, -1, 'Transisi, notifikasi, dan efek lucu dalam format WAV dan MP3.', 'sfx audio suara'],
  ['Source code aplikasi kasir berbasis Laravel', 250000, 'bengkel-kode', 'digital', 'software', '💻', 240, 5.0, 3, 3, 3, 0, 20, 'Kasir berbasis web dengan stok, laporan penjualan, dan banyak pengguna. Termasuk file database dan panduan instalasi.', 'kasir pos laravel'],
  ['Plugin WordPress formulir pemesanan', 85000, 'bengkel-kode', 'digital', 'software', '🧩', 170, 0, 0, 0, 2, 1, -1, 'Form pesanan yang langsung terkirim ke WhatsApp penjual, tanpa coding.', 'wordpress plugin'],
  ['Jasa desain logo UMKM, 3 kali revisi', 150000, 'nara-studio', 'jasa', 'desain', '🎨', 320, 5.0, 88, 410, 85, 0, 10, 'Tiga konsep awal, tiga kali revisi, file akhir PNG, SVG, dan PDF. Estimasi 3 hari kerja.', 'logo desain branding'],
  ['Jasa desain thumbnail YouTube', 25000, 'warung-pixel', 'jasa', 'desain', '🖌️', 50, 4.9, 190, 980, 70, 0, 30, 'Thumbnail 1280×720 yang tetap jelas dibaca di layar HP. Selesai dalam 24 jam.', 'thumbnail youtube'],
  ['Jasa edit video Reels atau TikTok, per 60 detik', 40000, 'nara-studio', 'jasa', 'video', '✂️', 0, 4.8, 120, 640, 60, 0, 20, 'Potong, subtitle, musik, dan transisi. Kirim bahan mentah lewat chat.', 'edit video reels tiktok'],
  ['Jasa pembuatan website company profile', 1200000, 'bengkel-kode', 'jasa', 'web', '🌐', 195, 5.0, 2, 2, 4, 0, 3, 'Website 5 halaman dengan domain dan hosting 1 tahun, bisa diedit sendiri. Estimasi 10 hari kerja.', 'website web'],
  ['Jasa cek status IMEI terdaftar', 5000, 'cahaya-digital', 'jasa', 'lainnya', '📱', 180, 4.9, 450, 1300, 50, 0, -1, 'Cek apakah IMEI ponsel sudah terdaftar resmi. Hasil dikirim dalam 15 menit.', 'imei hp'],
  ['Jasa terjemahan Indonesia–Inggris, per halaman', 35000, 'lintang-store', 'jasa', 'lainnya', '🌏', 160, 0, 0, 0, 0, 0, 50, 'Terjemahan dokumen umum, maksimal 250 kata per halaman. Selesai 1–2 hari.', 'translate terjemah english inggris']
];
// S&K contoh per kategori. Admin bisa mengubahnya per produk di /admin.
const TERMS = {
  game: '- Pastikan ID pemain dan server sudah benar sebelum bayar. Salah ID bukan tanggung jawab penjual.\n- Proses 1–5 menit setelah pembayaran diterima. Di jam sibuk bisa sampai 30 menit.\n- Item yang sudah masuk ke akun tidak bisa dibatalkan atau dikembalikan.\n- Ada kendala? Ajukan komplain dari halaman pesanan sebelum konfirmasi.',
  digital: '- File dikirim lewat chat pesanan setelah pembayaran diterima.\n- Lisensi untuk pemakaian pribadi, kecuali disebutkan lisensi komersial.\n- Dilarang menjual ulang atau membagikan file.\n- File yang sudah dikirim tidak bisa dikembalikan, kecuali rusak atau tidak sesuai deskripsi.',
  jasa: '- Kirim brief lengkap lewat chat setelah bayar.\n- Estimasi pengerjaan dihitung sejak brief lengkap diterima.\n- Revisi sesuai jumlah di deskripsi. Revisi tambahan dikenai biaya.\n- Dana diteruskan ke penjual setelah kamu setujui hasil akhirnya.'
};
const MEMBERS = ['Fajar', 'Putri', 'Andi', 'Sari', 'Nadia', 'Yoga', 'Bagus', 'Dimas', 'Rizky', 'Wulan'];
const REVIEW_TEXT = {
  game: ['Masuk kurang dari 5 menit. Mantap.', 'Proses cepat, penjual responsif.', 'Sudah langganan di sini, aman terus.'],
  digital: ['File lengkap sesuai deskripsi.', 'Link unduhan langsung dikirim, rapi.', 'Desainnya bagus dan gampang diedit.'],
  jasa: ['Revisi cepat dan hasilnya sesuai brief.', 'Komunikatif, hasilnya memuaskan.', 'Tepat waktu. Nanti order lagi.']
};
// [board, kategori, disematkan, judul, penulis, jam lalu, dilihat, id produk (urutan di PRODUCTS, mulai 1), isi, balasan [penulis, isi]]
const THREADS = [
  ['diskusi', 'promo', 1, 'Diamond Mobile Legends lebih murah sampai akhir bulan', 'Kedai Diamond', 72, 1240, 1, 'Semua paket diamond Mobile Legends turun harga sampai tanggal 30. Stok aman, proses otomatis.', [['Bagus', 'Weekly pass ikut promo juga?'], ['Kedai Diamond', 'Weekly pass belum, kak. Khusus paket diamond.']]],
  ['diskusi', 'produk', 0, 'Top up diamond ML biasanya masuk berapa lama?', 'Fajar', 2, 342, 1, 'Baru pertama kali beli di sini. Kalau pakai QRIS, diamond masuk berapa menit ya? Takut salah input ID juga.', [['Kedai Diamond', 'Rata-rata 1–5 menit setelah pembayaran diterima, kak. Kalau ID salah, pesanan kami tahan dulu dan kami konfirmasi lewat chat.'], ['Sari', 'Punyaku kemarin masuk sekitar 2 menit.']]],
  ['diskusi', 'produk', 0, 'Template undangan bisa diedit dari HP?', 'Putri', 5, 198, 12, 'Aku nggak punya laptop. Masih bisa ganti nama dan foto dari HP?', [['Rumah Template', 'Bisa, kak. Versi web diedit lewat formulir, versi gambar lewat aplikasi Canva di HP.']]],
  ['diskusi', 'penjual', 0, 'Penjual belum balas chat, sebaiknya gimana?', 'Andi', 24, 510, null, 'Sudah bayar sejak pagi, status masih dana ditahan rekber. Chat belum dibalas.', [['Admin Sapecc', 'Dana kamu aman di rekber. Kalau penjual tidak mengirim dalam 1×24 jam, ajukan komplain dari halaman pesanan.']]],
  ['diskusi', 'penjual', 0, 'Beda penjual Terpercaya dan Bintang apa ya?', 'Nadia', 96, 388, null, 'Sering lihat dua label ini di kartu produk. Mana yang lebih aman?', [['Admin Sapecc', 'Terpercaya untuk penjual dengan lebih dari 1.000 pesanan selesai. Bintang untuk penjual yang performanya konsisten dan jarang dikomplain. Semua transaksi tetap lewat rekber.']]],
  ['forum', 'info', 1, 'Aturan komunitas dan cara melaporkan penipuan', 'Admin Sapecc', 336, 4820, null, 'Semua transaksi wajib lewat rekber. Laporkan akun yang meminta transfer langsung, sertakan tangkapan layar chat.', []],
  ['forum', 'tips', 0, 'Foto produk digital yang bikin orang klik', 'Nara Studio', 24, 760, null, 'Tampilkan hasil akhirnya, bukan file mentahnya. Untuk template, pakai mockup di layar HP. Untuk preset, tunjukkan foto sebelum dan sesudah.', [['Lintang Store', 'Setuju. Sejak pakai foto sebelum-sesudah, chat masuk jauh lebih banyak.']]],
  ['forum', 'tips', 0, 'Cara pasang harga biar tetap untung setelah biaya rekber', 'Bengkel Kode', 48, 430, null, 'Hitung dulu biaya rekber yang kamu tanggung, baru tambahkan margin. Ada kalkulatornya di menu Tools.', []],
  ['forum', 'game', 0, 'Hero ML andalan season ini apa?', 'Dimas', 3, 215, null, 'Lagi cari hero jungler yang gampang dipakai buat naik rank.', [['Rizky', 'Coba yang sustain-nya tinggi dulu, lebih aman buat solo queue.']]],
  ['forum', 'santai', 0, 'Kenalan dulu, penjual baru di sini', 'Lintang Store', 20, 140, null, 'Halo semua! Aku jual template Excel dan sound effect. Salam kenal.', [['Putri', 'Salam kenal! Template keuangannya ada versi Google Sheets?']]]
];

async function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM shops').get().n > 0) return false;
  // Akun contoh penjual bisa dipakai login untuk mencoba alur penjual (sandi: sapecc123).
  const sellerHash = await hashPassword('sapecc123');
  const lockedHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
  tx(db, () => {
    const userIdByName = {};
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (admin) userIdByName['Admin Sapecc'] = admin.id;
    const shopIdBySlug = {};
    for (const [username, slug, name, badge, baseOrders, year, city, resp, hue] of SHOPS) {
      const created = new Date(`${year}-03-01T00:00:00Z`).getTime();
      const u = db.prepare('INSERT INTO users (username, email, name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, `${username}@sapecc.test`, name, sellerHash, created);
      const s = db.prepare('INSERT INTO shops (user_id, slug, name, city, badge, base_orders, resp, hue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(u.lastInsertRowid, slug, name, city, badge, baseOrders, resp, hue, created);
      userIdByName[name] = Number(u.lastInsertRowid);
      shopIdBySlug[slug] = Number(s.lastInsertRowid);
    }
    for (const m of MEMBERS) {
      const u = db.prepare('INSERT INTO users (username, email, name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(m.toLowerCase(), `${m.toLowerCase()}@contoh.sapecc.test`, m, lockedHash, now() - 200 * DAY);
      userIdByName[m] = Number(u.lastInsertRowid);
    }
    const productIds = [];
    PRODUCTS.forEach((p, i) => {
      const [name, price, slug, cat, sub, icon, hue, rating, reviews, sold, age, auto, stock, desc, keywords] = p;
      const r = db.prepare(`INSERT INTO products (shop_id, name, price, cat, sub, icon, hue, description, terms, keywords, auto, stock, sold, rating, reviews, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(shopIdBySlug[slug], name, price, cat, sub, icon, hue, desc, TERMS[cat], keywords, auto, stock, sold, rating, reviews, now() - age * DAY - i * 60000);
      const pid = Number(r.lastInsertRowid);
      productIds.push(pid);
      // Beberapa ulasan contoh (angka rating dan jumlah ulasan di atas mewakili riwayat lama).
      for (let k = 0; k < Math.min(3, reviews); k++) {
        db.prepare('INSERT INTO reviews (product_id, user_id, stars, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(pid, userIdByName[MEMBERS[(i + k) % MEMBERS.length]], k === 2 ? 4 : 5, REVIEW_TEXT[cat][k], now() - (k * 4 + 2) * DAY);
      }
    });
    for (const [board, cat, pinned, title, by, hoursAgo, views, pIndex, body, replies] of THREADS) {
      const uid = userIdByName[by];
      if (!uid) continue;
      const created = now() - hoursAgo * 3600e3;
      const r = db.prepare('INSERT INTO threads (board, cat, title, body, user_id, product_id, pinned, views, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(board, cat, title, body, uid, pIndex ? productIds[pIndex - 1] : null, pinned, views, created);
      replies.forEach(([rb, text], j) => {
        if (userIdByName[rb]) db.prepare('INSERT INTO replies (thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
          .run(r.lastInsertRowid, userIdByName[rb], text, created + (j + 1) * 1800e3);
      });
    }
  });
  return true;
}

module.exports = { ensureAdmin, seedDemo };
