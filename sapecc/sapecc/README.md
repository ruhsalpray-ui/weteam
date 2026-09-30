# Sapecc

Marketplace produk digital dengan rekber (rekening bersama). Uang pembeli ditahan dulu, lalu baru diteruskan ke penjual setelah pembeli mengonfirmasi pesanan.

Proyek ini tidak butuh `npm install`. Semua memakai modul bawaan Node.js, termasuk database SQLite (`node:sqlite`).

## Yang dibutuhkan

- Node.js versi **22.13 atau lebih baru** (disarankan versi LTS terbaru). Cek dengan `node -v`.

## Menjalankan di komputer sendiri

```bash
cp .env.example .env      # lalu sesuaikan isinya
npm start                 # atau: node server.js
```

Buka http://localhost:3000. Saat pertama jalan, server otomatis membuat database di `data/sapecc.db` dan mengisi data contoh.

Akun untuk mencoba:

| Peran | Login | Kata sandi |
|---|---|---|
| Admin | isi `ADMIN_EMAIL` di `.env` | isi `ADMIN_PASSWORD` di `.env` |
| Penjual contoh | `kedaidiamond` (juga `sinartopup`, `warungpixel`, `rumahtemplate`, `narastudio`, `cahayadigital`, `bengkelkode`, `lintangstore`) | `sapecc123` |
| Pembeli | daftar sendiri lewat tombol Daftar | |

Panel admin ada di http://localhost:3000/admin. Isinya:

- **Ringkasan.** Dana yang ditahan, keputusan komplain, persetujuan penarikan saldo, dan pesanan terbaru.
- **Produk.** Atur logo, nama, deskripsi, dan S&K setiap produk, dengan pratinjau seperti yang dilihat pelanggan. Saringan "Belum ada S&K" dan "Belum ada logo" membantu menemukan produk yang belum lengkap.
- **Logo aplikasi.** Unggah logo sekali per aplikasi (misalnya Mobile Legends). Logo itu dipakai semua produk aplikasi tersebut yang belum punya logo sendiri.

Cara menulis deskripsi dan S&K supaya mudah dibaca pelanggan:
- Baris yang diawali tanda `- ` tampil sebagai poin.
- Baris yang diawali `1. ` tampil sebagai daftar bernomor.

Pelanggan wajib mencentang "sudah membaca S&K" sebelum membayar produk yang punya S&K.

Selama `PAYMENT_PROVIDER=mock`, tombol bayar membuka halaman simulasi. Di halaman itu kamu bisa memilih "berhasil" atau "batal", jadi seluruh alur bisa dicoba tanpa uang sungguhan.

### Menjalankan pengujian

```bash
npm test
```

Pengujian otomatis mencakup:
- alur beli dari awal sampai dana cair
- rekber dengan komplain yang di-refund admin
- pembayaran gagal
- dana cair otomatis
- perlindungan keamanan

## Alur rekber

```
awaiting_payment ──bayar──▶ held ──penjual kirim──▶ shipped ──pembeli konfirmasi──▶ completed (dana ke penjual)
       │                     │                          │
       └─batal/kedaluwarsa   ├─penjual tolak──▶ refunded (dana ke saldo pembeli)
         ▶ cancelled         └─komplain──▶ complained ──admin──▶ refunded / completed
```

- **Pesanan (keranjang).** Satu pesanan dibuat per toko. Harga selalu dihitung ulang di server.
- **Rekber langsung** (menu Rekber). Untuk transaksi yang sudah disepakati di luar katalog, misalnya di grup atau media sosial. Pembeli atau penjual boleh membuatnya, dan lawan transaksi harus sudah punya akun.
- **Dana cair otomatis.** Setelah penjual menandai terkirim, dana diteruskan otomatis kalau pembeli tidak merespons dalam `AUTO_RELEASE_HOURS` (bawaan 72 jam).
- **Pesanan tidak dibayar** dibatalkan setelah `PAYMENT_EXPIRE_HOURS` (bawaan 24 jam), dan stoknya dikembalikan.
- **Semua perubahan saldo** tercatat di tabel `ledger`. Refund dan pembatalan dikembalikan ke saldo Sapecc pembeli.

## Menyambungkan Midtrans

1. Daftar di https://midtrans.com lalu buka dashboard **Sandbox**.
2. Salin **Server Key** ke `.env`:
   ```
   PAYMENT_PROVIDER=midtrans
   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxx
   MIDTRANS_PRODUCTION=0
   BASE_URL=https://domain-kamu.com
   ```
3. Di dashboard Midtrans, buka **Settings, Configuration**. Isi **Payment Notification URL** dengan `https://domain-kamu.com/api/payments/notify`.
4. Coba bayar dengan simulator sandbox Midtrans. Status pesanan berubah setelah notifikasi masuk.
5. Setelah akun production disetujui, ganti ke Server Key production dan set `MIDTRANS_PRODUCTION=1`.

Server memverifikasi setiap notifikasi dalam dua langkah:
- mencocokkan `signature_key` (SHA512 dari order_id, status_code, gross_amount, dan server key)
- menanyakan ulang statusnya langsung ke API Midtrans

Dengan begitu, notifikasi palsu tidak bisa menandai pesanan lunas.

Notifikasi hanya bisa diterima kalau server bisa diakses dari internet. Untuk mencoba dari laptop, pakai tunnel seperti ngrok atau Cloudflare Tunnel, lalu isi `BASE_URL` dengan alamat tunnel tersebut.

Biaya QRIS dan VA di `.env` adalah biaya yang kamu tagihkan ke pembeli. Sesuaikan dengan tarif MDR di kontrak Midtrans kamu.

## Online (production)

Di `.env` server:

```
NODE_ENV=production
BASE_URL=https://domain-kamu.com
COOKIE_SECURE=1
SEED_DEMO=0
TRUST_PROXY=1            # kalau di belakang Nginx / Cloudflare
PAYMENT_PROVIDER=midtrans
ADMIN_EMAIL=...
ADMIN_PASSWORD=...       # minimal 12 karakter, acak
```

Contoh di VPS (Ubuntu):
- Jalankan dengan `pm2 start server.js --node-args="--disable-warning=ExperimentalWarning"` atau systemd, supaya otomatis hidup lagi saat server restart.
- Pasang Nginx sebagai reverse proxy ke port 3000, dan HTTPS dari Let's Encrypt (`certbot`). HTTPS wajib, karena cookie login hanya dikirim lewat HTTPS saat production.
- **Backup** file `data/sapecc.db` dan folder `data/uploads` (logo) secara berkala, misalnya tiap hari dengan cron. File ini berisi semua akun, saldo, dan transaksi.

Tersedia juga `Dockerfile`. Pasang volume ke `/app/data` supaya database tidak hilang.

Dalam mode production, pembayaran simulasi otomatis ditolak.

## Struktur

```
server.js          HTTP server, routing, keamanan, file statis
src/config.js      pengaturan dari .env
src/db.js          skema database dan transaksi
src/auth.js        hash kata sandi (scrypt) dan sesi login
src/escrow.js      logika rekber, saldo, pembayaran, tugas otomatis
src/payments.js    Midtrans Snap dan mode simulasi
src/uploads.js     simpan dan sajikan logo (hanya PNG, JPG, WebP asli)
src/api.js         semua endpoint /api
src/seed.js        akun admin dan data contoh
src/meta.js        daftar kategori (samakan dengan CATS di public/index.html)
public/index.html  tampilan situs
public/admin.html  panel admin
test/              pengujian otomatis
```

## Keamanan yang sudah ada

- **Kata sandi** di-hash dengan scrypt. Sesi disimpan sebagai hash, dan cookie-nya `HttpOnly` dan `SameSite=Lax`.
- **Perlindungan CSRF.** Permintaan yang mengubah data wajib JSON, dan Origin-nya dicek.
- **Pembatasan percobaan** untuk login, daftar, posting, dan chat.
- **Harga, stok, dan hak akses** selalu dicek di server. Pembeli tidak bisa menandai pesanan terkirim, dan penjual tidak bisa mengonfirmasi pesanannya sendiri.
- **Operasi uang** dijalankan di dalam transaksi database, dan saldo tidak bisa minus.
- **Header keamanan** (CSP, X-Frame-Options, dan lainnya). Semua teks dari pengguna di-escape sebelum ditampilkan.

## Belum ada (langkah berikutnya)

- **Akun:** verifikasi email, lupa kata sandi, dan login dua langkah.
- **Kirim file:** upload file produk digital, supaya penjual bisa mengirim file langsung di pesanan.
- **Notifikasi:** lewat email atau WhatsApp saat status pesanan berubah. Saat ini chat dan status masih diperbarui dengan polling, belum real-time.
- **Kelola produk:** mengubah harga atau deskripsi produk dari halaman toko. API `PATCH /api/shop/products/:id` sudah mendukung, tinggal tampilannya.
- **Refund:** pengembalian dana ke metode bayar asli. Saat ini refund masuk ke saldo Sapecc.
- **Skala:** verifikasi identitas penjual, dan pencarian di server kalau jumlah produk sudah ribuan.

## Catatan hukum

Menahan dana pengguna (rekber dan saldo) di Indonesia bisa termasuk kegiatan yang diatur Bank Indonesia dan OJK. Sebelum menerima transaksi sungguhan, konsultasikan dengan ahli hukum. Pertimbangkan juga memakai layanan escrow atau e-money dari penyedia pembayaran berlisensi.

Siapkan juga halaman Ketentuan Layanan dan Kebijakan Privasi yang sesuai UU Pelindungan Data Pribadi.
