'use strict';
// Kategori dan "aplikasi" (subkategori). Nama dan ikon di sini dipakai panel admin.
// Kalau menambah atau mengubah, samakan juga dengan CATS di public/index.html.
const CATS = {
  digital: { name: 'Produk Digital', subs: { template: ['Template', '📄'], ebook: ['E-book & kelas', '📘'], aset: ['Aset kreatif', '🎧'], software: ['Software & kode', '💻'] } },
  game: { name: 'Produk Game', subs: { roblox: ['Roblox', '🧱'], 'mobile-legends': ['Mobile Legends', '💎'], valorant: ['Valorant', '🎯'], 'pubg-mobile': ['PUBG Mobile', '🪂'], 'free-fire': ['Free Fire', '🔥'], 'point-blank': ['Point Blank', '🎖️'], 'genshin-impact': ['Genshin Impact', '✨'] } },
  jasa: { name: 'Jasa', subs: { desain: ['Desain', '🎨'], video: ['Edit video', '✂️'], web: ['Website', '🌐'], lainnya: ['Lainnya', '📱'] } }
};
const validSub = (cat, sub) => !!(CATS[cat] && Object.prototype.hasOwnProperty.call(CATS[cat].subs, sub));
const BOARDS = {
  diskusi: ['produk', 'penjual', 'promo'],
  forum: ['info', 'tips', 'game', 'santai']
};
module.exports = { CATS, BOARDS, validSub };
