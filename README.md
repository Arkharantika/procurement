# Procurement Price Finder Prototype

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
PostgreSQL hybrid — pg_trgm (word_similarity) + pgvector (cosine),
digabung Reciprocal Rank Fusion → top-8 kandidat
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

Ini pola **retrieval-then-rerank**: retrieval (trigram + vektor) cuma penyaring cepat, LLM
yang jadi hakim, user cuma dipanggil kalau LLM pun ragu. Konsekuensinya ambang batas skor
retrieval tidak perlu ditebak-tebak — ia hanya menentukan siapa yang masuk daftar kandidat,
bukan siapa yang menang. Dua jalur retrieval saling melengkapi: trigram kuat untuk kode
model/part number dan typo, vektor kuat untuk deskripsi natural dan lintas bahasa
("casual shoes dark" menemukan "Sepatu ... Hitam"). Kalau layanan embedding sedang down,
pencarian turun anggun ke trigram-only, bukan error.

Mekanisme "pause" diimplementasikan dengan menyimpan `Promise` yang belum di-resolve di
`src/services/priceFinder.js` (lihat registry `sessions` + fungsi `askUser`). Loop utama
benar-benar berhenti menunggu jawaban user sebelum lanjut ke baris berikutnya. Ada dua jalan
keluar supaya loop tidak bisa menggantung selamanya: **timeout** 5 menit per pertanyaan
(auto-skip), dan **pembatalan** otomatis saat socket terakhir di sesi itu putus.

## Struktur folder

```
estimacore-pricefinder/
├── server.js                     # Entry point: Express + Socket.io + /api/upload + /api/export
├── docker-compose.yml            # Postgres 17 + pgvector (port host 5433)
├── database/
│   ├── buat_tabel.sql            # Schema: products + pg_trgm & pgvector + index HNSW
│   ├── buat_tabel.js             # Terapkan buat_tabel.sql ke database (npm run init-db)
│   ├── koneksi_database.js       # Koneksi Sequelize (dipakai runtime server)
│   ├── list_dummy_item.js        # Isi 60 data contoh berklaster (npm run seed)
│   └── isi_embedding.js          # Backfill kolom embedding (npm run embed)
├── src/
│   ├── loadEnv.js                # Muat .env dari root, apa pun direktori kerjanya
│   ├── Product.js                # Model Sequelize tabel products
│   ├── handlers.js               # Event Socket.io
│   ├── productRoutes.js          # REST CRUD katalog (/api/products) + re-embed otomatis
│   ├── services/
│   │   ├── aiService.js          # OpenRouter: extractLine() + rerankCandidates()
│   │   ├── embeddingService.js   # OpenRouter embeddings: embedText() dkk.
│   │   ├── searchService.js      # Hybrid pg_trgm + pgvector, digabung RRF
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

Prasyarat: Node.js ≥ 18 dan **Docker Desktop** (untuk database — lihat langkah 2).

1. **Install dependencies**

   ```bash
   npm install
   ```

   > Catatan: `xlsx` sengaja ditarik dari tarball resmi SheetJS (`cdn.sheetjs.com`),
   > bukan dari npm registry — versi npm-nya (`0.18.5`) punya CVE yang tidak pernah
   > dipatch. Kalau jaringanmu memblokir CDN itu, `npm install` akan gagal di paket ini.

2. **Jalankan database** — Postgres 17 + pgvector via Docker:

   ```bash
   docker compose up -d
   ```

   Container dengar di port host **5433** (bukan 5432), supaya tidak bentrok dengan
   instalasi PostgreSQL lokal yang mungkin sudah ada. Kredensial default ada di
   `docker-compose.yml` dan harus sama dengan `DATABASE_URL` di `.env`.

   > Kenapa Docker? Pencarian vektor butuh extension **pgvector**, yang tidak tersedia
   > di installer PostgreSQL Windows biasa (harus compile manual). Image
   > `pgvector/pgvector:pg17` sudah membawanya. Kalau kamu sudah punya Postgres lain
   > yang ber-pgvector, boleh dipakai langsung — cukup arahkan `DATABASE_URL` ke sana.

3. **Salin `.env.example` ke `.env`** dan isi `DATABASE_URL` (port 5433 kalau pakai
   Docker di atas), `OPENROUTER_API_KEY`, dan `SERPAPI_KEY`.

   ```bash
   cp .env.example .env
   ```

   Server **menolak start** kalau salah satu dari ketiganya kosong, dan menyebutkan
   mana yang kurang — jadi env yang hilang ketahuan langsung, bukan di tengah proses.

4. **Buat tabel `products`**

   ```bash
   npm run init-db
   ```

5. **(Opsional) Isi data contoh** — 60 produk di 6 kategori (footwear, watches, furniture,
   ATK, IT equipment, electronics). Data ini sengaja **berklaster**: tiap item punya
   beberapa varian yang beda tipis (ukuran 41/42/43, kode model 1A1/1A4), supaya jalur
   "ambigu" dan LLM re-ranking ikut teruji — katalog yang tiap barisnya unik tidak akan
   pernah memicu jalur tersebut.

   ```bash
   npm run seed              # menolak jalan kalau tabel sudah terisi
   npm run seed -- --reset   # HAPUS semua isi tabel, lalu seed ulang
   ```

6. **Isi kolom embedding** (untuk pencarian vektor/semantik):

   ```bash
   npm run embed             # hanya baris yang masih kosong (idempotent)
   npm run embed -- --all    # paksa embed ulang semua (setelah ganti model embedding)
   ```

   Tanpa langkah ini pencarian tetap jalan, tapi trigram-only — query natural/lintas
   bahasa ("casual shoes dark" terhadap katalog "Sepatu ... Hitam") tidak akan ketemu.
   Produk yang dibuat/diedit lewat halaman katalog otomatis di-embed sendiri; script ini
   hanya untuk backfill massal (setelah seed) atau menambal yang gagal.

7. **Jalankan server**

   ```bash
   npm start
   ```

   Buka `http://localhost:3001` di browser. Paste beberapa baris barang atau upload file,
   klik proses, dan kalau ada yang ambigu akan muncul pop-up pilihan.

## Catatan tuning

- Ambang batas semuanya eksplisit di source code:
  - `SEARCH_MIN_SCORE` (`src/services/searchService.js`) — batas bawah trigram masuk
    daftar kandidat. Longgarkan kalau kandidat yang benar sering tidak muncul.
  - `VECTOR_MIN_SIM` (`src/services/searchService.js`) — batas bawah cosine jalur vektor.
    Tanpa floor ini kandidat tidak pernah kosong (vektor selalu punya "tetangga terdekat")
    dan fallback internet mati diam-diam. Angka kalibrasinya ada di komentar file itu —
    ukur ulang kalau ganti model embedding.
  - `AUTO_MATCH_SCORE`, `AUTO_MATCH_GAP`, `RERANK_AUTO_CONFIDENCE`
    (`src/services/priceFinder.js`) — kapan boleh auto-pilih tanpa tanya user. Ketatkan
    kalau sistem terlalu sering salah pilih diam-diam; longgarkan kalau terlalu cerewet.
- Pencarian memakai `word_similarity(query, name)`, bukan `similarity()`. `similarity()`
  menghukum selisih panjang string, jadi query pendek yang dicocokkan ke nama produk panjang
  dapat skor rendah walaupun jelas cocok — persis kasus yang paling sering terjadi di sini.
- Modul ini TIDAK bergantung pada GUC `pg_trgm.*_threshold` milik server Postgres; semua
  ambang batas dipegang di kode. Lihat catatan di `database/buat_tabel.sql` kalau
  katalog sudah besar dan seq scan mulai terasa.
- Model LLM diatur lewat `OPENROUTER_MODEL` di `.env` (default `openai/gpt-5-mini`); model
  embedding lewat `OPENROUTER_EMBEDDING_MODEL` (default `openai/text-embedding-3-large`,
  dipangkas ke 1024 dimensi). Ganti model LLM itu murah; ganti model **embedding** tidak —
  dimensi kolom `vector(1024)` terkunci ke model, wajib `npm run embed -- --all` dan
  kalibrasi ulang `VECTOR_MIN_SIM`.
- Baris yang sama persis dalam satu sesi dijawab dari cache — tidak memicu AI call atau
  pertanyaan ulang.
- Ini prototype: tidak ada penyimpanan hasil (import batch/items) ke database sesuai
  keputusan desain — hasil akhir hanya dikirim ke client via event `done`, silakan
  disimpan/diekspor sesuai kebutuhan modul yang memanggilnya.
