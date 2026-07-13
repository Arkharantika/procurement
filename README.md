# EstimaCore — Price Finder Prototype

Modul price finder generic lintas bidang bisnis: kirim daftar barang (paste teks atau upload
Excel/CSV/TXT), sistem mencari tiap baris ke database produk secara berurutan, dan berhenti
sejenak untuk bertanya ke user setiap kali hasilnya ambigu atau tidak ditemukan (lalu fallback
ke pencarian internet via SerpAPI).

Tidak ada modul lain di luar ini — tidak ada login, approval, PO, invoice, margin/markup
(itu diatur manual oleh merchant di luar sistem), maupun multi-tenant. Database hanya satu
tabel: `products`.

## Arsitektur singkat

```
Baris teks
    │
    ▼
AI (OpenRouter) — extract name + qty + unit
    │
    ▼
PostgreSQL pg_trgm — saring jadi top-8 kandidat (word_similarity)
    │
    ├── Skor sangat tinggi & jelas #1 → auto-pilih (LLM dilewati)
    │
    ▼
LLM re-ranking — pilih 1 dari kandidat tadi + confidence
    │
    ├── Confidence tinggi        → auto-pilih, lanjut baris berikutnya
    │
    ├── Confidence rendah        → PAUSE, tanya user (saran AI ditandai)
    │
    └── Tidak ada yang cocok     → SerpAPI → sampai 5 supplier → PAUSE, tanya user
```

Ini pola **retrieval-then-rerank**: trigram cuma penyaring cepat, LLM yang jadi hakim, user
cuma dipanggil kalau LLM pun ragu. Konsekuensinya ambang batas skor trigram tidak perlu
ditebak-tebak — ia hanya menentukan siapa yang masuk daftar kandidat, bukan siapa yang menang.

Mekanisme "pause" diimplementasikan dengan menyimpan `Promise` yang belum di-resolve di
`src/services/priceFinder.js` (lihat registry `sessions` + fungsi `askUser`). Loop utama
benar-benar berhenti menunggu jawaban user sebelum lanjut ke baris berikutnya. Ada dua jalan
keluar supaya loop tidak bisa menggantung selamanya: **timeout** 5 menit per pertanyaan
(auto-skip), dan **pembatalan** otomatis saat socket terakhir di sesi itu putus.

## Struktur folder

```
estimacore-pricefinder/
├── server.js                     # Entry point: Express + Socket.io + /api/upload + /api/export
├── database/
│   ├── buat_tabel.sql            # Schema: tabel products + extension pg_trgm
│   ├── buat_tabel.js             # Terapkan buat_tabel.sql ke database (npm run init-db)
│   ├── koneksi_database.js       # Koneksi Sequelize (dipakai runtime server)
│   └── list_dummy_item.js        # Isi 60 data contoh berklaster (npm run seed)
├── src/
│   ├── loadEnv.js                # Muat .env dari root, apa pun direktori kerjanya
│   ├── Product.js                # Model Sequelize tabel products
│   ├── handlers.js               # Event Socket.io
│   ├── productRoutes.js          # REST CRUD katalog (/api/products)
│   ├── services/
│   │   ├── aiService.js          # OpenRouter: extractLine() + rerankCandidates()
│   │   ├── searchService.js      # Query pg_trgm word_similarity
│   │   ├── internetService.js    # SerpAPI google_shopping + fallback organik
│   │   └── priceFinder.js        # Loop utama + mekanisme pause/resume
│   └── utils/
│       ├── fileParser.js         # Parser Excel/CSV/TXT → array baris
│       └── excelExport.js        # Hasil → workbook Excel (subtotal dihitung ulang di sini)
└── public/
    ├── index.html                # Price Finder: tabel editable, margin, total, export Excel
    └── products.html             # Katalog produk: CRUD, cari, paginasi
```

## Dua halaman

| Halaman | URL | Fungsi |
|---|---|---|
| Price Finder | `/` | Proses daftar barang per baris, pilih kandidat saat ragu, edit hasil, unduh Excel |
| Katalog Produk | `/products.html` | CRUD tabel `products` — katalog yang dicari oleh Price Finder |

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

   > Catatan: `xlsx` sengaja ditarik dari tarball resmi SheetJS (`cdn.sheetjs.com`),
   > bukan dari npm registry — versi npm-nya (`0.18.5`) punya CVE yang tidak pernah
   > dipatch. Kalau jaringanmu memblokir CDN itu, `npm install` akan gagal di paket ini.

2. **Siapkan database PostgreSQL**, lalu salin `.env.example` ke `.env` dan isi
   `DATABASE_URL`, `OPENROUTER_API_KEY`, dan `SERPAPI_KEY`.

   ```bash
   cp .env.example .env
   ```

   Server **menolak start** kalau salah satu dari ketiganya kosong, dan menyebutkan
   mana yang kurang — jadi env yang hilang ketahuan langsung, bukan di tengah proses.

3. **Buat tabel `products`**

   ```bash
   npm run init-db
   ```

4. **(Opsional) Isi data contoh** — 60 produk di 6 kategori (footwear, watches, furniture,
   ATK, IT equipment, electronics). Data ini sengaja **berklaster**: tiap item punya
   beberapa varian yang beda tipis (ukuran 41/42/43, kode model 1A1/1A4), supaya jalur
   "ambigu" dan LLM re-ranking ikut teruji — katalog yang tiap barisnya unik tidak akan
   pernah memicu jalur tersebut.

   ```bash
   npm run seed              # menolak jalan kalau tabel sudah terisi
   npm run seed -- --reset   # HAPUS semua isi tabel, lalu seed ulang
   ```

5. **Jalankan server**

   ```bash
   npm start
   ```

   Buka `http://localhost:3001` di browser. Paste beberapa baris barang atau upload file,
   klik proses, dan kalau ada yang ambigu akan muncul pop-up pilihan.

## Catatan tuning

- Ambang batas ada di dua tempat, keduanya eksplisit di source code:
  - `SEARCH_MIN_SCORE` (`src/services/searchService.js`) — batas bawah kandidat yang layak
    dipertimbangkan sama sekali. Longgarkan kalau kandidat yang benar sering tidak muncul.
  - `AUTO_MATCH_SCORE`, `AUTO_MATCH_GAP`, `RERANK_AUTO_CONFIDENCE`
    (`src/services/priceFinder.js`) — kapan boleh auto-pilih tanpa tanya user. Ketatkan
    kalau sistem terlalu sering salah pilih diam-diam; longgarkan kalau terlalu cerewet.
- Pencarian memakai `word_similarity(query, name)`, bukan `similarity()`. `similarity()`
  menghukum selisih panjang string, jadi query pendek yang dicocokkan ke nama produk panjang
  dapat skor rendah walaupun jelas cocok — persis kasus yang paling sering terjadi di sini.
- Modul ini TIDAK bergantung pada GUC `pg_trgm.*_threshold` milik server Postgres; semua
  ambang batas dipegang di kode. Lihat catatan di `database/buat_tabel.sql` kalau
  katalog sudah besar dan seq scan mulai terasa.
- Model AI diatur lewat `OPENROUTER_MODEL` di `.env` — default `anthropic/claude-sonnet-4-6`.
- Baris yang sama persis dalam satu sesi dijawab dari cache — tidak memicu AI call atau
  pertanyaan ulang.
- Ini prototype: tidak ada penyimpanan hasil (import batch/items) ke database sesuai
  keputusan desain — hasil akhir hanya dikirim ke client via event `done`, silakan
  disimpan/diekspor sesuai kebutuhan modul yang memanggilnya.
