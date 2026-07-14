# CLAUDE.md — Konteks Proyek EstimaCore PriceFinder

File ini berisi rangkuman lengkap perjalanan desain modul ini — mulai dari diskusi awal,
masalah-masalah yang dibahas, solusi yang dipertimbangkan, sampai keputusan akhir yang
tercermin di source code. Tujuannya supaya siapa pun (termasuk Claude Code) yang melanjutkan
proyek ini punya konteks penuh tanpa perlu menjelaskan ulang dari nol.

## 1. Asal mula proyek

EstimaCore awalnya dibahas dari transkrip percakapan dengan ChatGPT (diringkas dalam PDF
~40 halaman) seputar aplikasi **RFQ/quotation price finder** untuk produk elektrikal
(MCCB, kontaktor, kabel, dll). Flow awal yang disepakati di percakapan tersebut:

```
Client kirim daftar barang → Import (Excel/PDF/paste) → AI extract jadi JSON
→ Matching ke database internal → Kalau tidak ketemu, cari di internet (SerpAPI)
→ User pilih supplier → Hitung margin → Generate quotation PDF
```

Scope sengaja dibatasi: **tidak** ada login vendor, approval, PO, invoice — murni modul
pencarian harga.

## 2. Masalah & solusi yang dibahas di PDF ChatGPT

Ini konteks penting karena beberapa keputusan desain di source code langsung berasal dari
diskusi ini:

### Masalah 1 — "Kalau pg_trgm gagal juga akhirnya pakai AI, kenapa tidak AI sejak awal?"
**Miskonsepsi yang diluruskan:** LLM tidak bisa "search database". LLM cuma bisa membaca apa
yang dikirim di prompt atau memanggil tool. Database berisi ratusan ribu produk tidak mungkin
dikirim seluruhnya ke LLM. **Solusi:** arsitektur retrieval-then-rerank — mesin pencari
(pg_trgm/embedding) mempersempit ke top-N kandidat, baru LLM memilih dari kandidat itu.

### Masalah 2 — AI generate SQL langsung dari input user
**Kenapa ditolak:** AI tidak tahu isi & struktur database. Contoh: AI bisa generate
`WHERE name ILIKE '%RAM16%'` padahal database menyimpan `ram = 16` di kolom terpisah — SQL
sintaksnya benar tapi hasilnya 0 row. **Solusi:** AI berperan sebagai *penerjemah intent ke
struktur* (`{"brand":"Lenovo","ram":"16GB"}`), backend yang bikin query — bukan AI generate
SQL mentah.

### Masalah 3 — kode `processPriceFinder` awal (versi elektrikal) terlalu boros API call
Kode awal memanggil AI (`extractKeywords`) satu kali per item. Untuk quotation 250 item =
250 API call. **Solusi yang disarankan:** balik urutan jadi rule-based/regex parser dulu →
baru AI kalau gagal, atau proses batch bukan per-item.

### Masalah 4 — ILIKE rapuh terhadap typo
`ILIKE '%MCCB%'` gagal untuk "MCBB" atau "MCC B". **Solusi:** pakai extension `pg_trgm`
(fuzzy/trigram search), jauh lebih toleran terhadap variasi penulisan dan typo.

### Masalah 5 — flow lama ambil 1 hasil langsung dari DB
**Solusi:** ubah jadi top-20 kandidat dari DB → LLM re-ranking untuk memilih yang paling cocok,
dengan prompt yang minta confidence score dan `NOT_FOUND` kalau di bawah ambang batas tertentu.

### Masalah 6 — SerpAPI langsung mengembalikan 1 harga pilihan AI
**Solusi:** ubah supaya SerpAPI + AI mengembalikan **daftar** kandidat supplier (harga,
sumber), dan **user yang memilih** — bukan AI yang otomatis pilih satu.

### Konsep besar yang disepakati dari diskusi PDF
- Layer 1: Fast retrieval (pg_trgm atau pgvector) → top-N kandidat dalam hitungan milidetik
- Layer 2: LLM reasoning hanya di atas kandidat tersebut, bukan seluruh database
- Layer 3 (belum diimplementasi di prototype ini): feedback loop dari koreksi user untuk
  meningkatkan akurasi matching dari waktu ke waktu

## 3. Evolusi scope dalam diskusi lanjutan

Setelah PDF di atas, proyek berkembang lewat beberapa keputusan besar:

1. **Dari spesifik elektrikal → generic lintas bidang bisnis.** User ingin modul ini bisa
   dipakai untuk bidang apa pun (elektrikal, furniture, ATK, dll), bukan cuma satu vertikal.
   Konsekuensinya: tidak boleh ada kolom skema tetap yang spesifik domain (seperti `ampere`,
   `ram`), dan rule-based/regex parser jadi kurang relevan karena polanya terlalu beragam
   antar bidang.

2. **Estimasi awal skema lengkap** (sempat diusulkan, TIDAK dipakai di prototype ini):
   tabel `products` dengan `owner_id` (multi-tenant), `attributes JSONB`, plus tabel terpisah
   `import_batches`, `import_items`, `internet_candidates`, `match_feedback`. Ini didesain
   untuk skenario produksi jangka panjang.

3. **Simplifikasi ke prototype** — user secara eksplisit memangkas scope:
   - Tidak perlu multi-tenant
   - Tidak perlu `import_batches` / `import_items` (tidak ada penyimpanan proses import)
   - Database **hanya** satu tabel: `products`
   - AI loop **per baris** (bukan batch semua sekaligus) — karena sifatnya interaktif
   - Kalau ada beberapa kandidat mirip → **pause**, tanya user pilih mana
   - Kalau tidak ketemu di DB → baru cari internet, dengan pola sama: tampilkan top-3,
     pause, tanya user
   - Margin/markup **tidak dihitung** sistem — itu urusan manual merchant di luar modul ini
   - Parser tidak perlu menangani PDF hasil scan/gambar — input selalu berupa teks/Excel
     bersih (sudah ada aplikasi scanner terpisah)

4. **Klarifikasi terakhir sebelum coding:**
   - Mode "pause": **interaktif real-time per baris** (bukan proses semua dulu baru review
     bareng di akhir)
   - Qty **ikut diekstrak** oleh AI bersama nama produk (bukan cuma nama saja)

## 4. Keputusan desain final (tercermin di source code)

- **Satu tabel `products` saja** — lihat `database/buat_tabel.sql`. Kolom: id,
  name, brand, category, price, unit, embedding. Sengaja tidak ada kolom atribut
  spesifik domain.
- **Database jalan di Docker, bukan Postgres Windows** (REVISI 2026-07-14) — container
  `pgvector/pgvector:pg17` via `docker-compose.yml`, port host **5433**. Alasannya:
  pgvector tidak tersedia di Postgres Windows biasa (perlu compile manual). Postgres
  Windows lama tetap hidup di 5432 tapi TIDAK dipakai aplikasi — isinya data lama
  pra-hybrid, jangan bingung kalau isinya beda. Konsekuensi: Docker Desktop harus jalan
  saat aplikasi dipakai (`restart: unless-stopped` + auto-start Docker mengurusnya).
- **Hybrid pg_trgm + pgvector** (REVISI 2026-07-14 — dulu "pg_trgm saja, hybrid nanti").
  Pemicunya: query lintas bahasa ("casual shoes dark" vs katalog "Sepatu ... Hitam")
  skor trigramnya ~0.05, selalu jatuh ke internet padahal barangnya ada. Sekarang
  `searchProduct()` menggabungkan kandidat trigram + kandidat vektor (cosine) dengan
  **Reciprocal Rank Fusion** — skor kedua jalur tidak sebanding secara langsung, jadi
  digabung lewat peringkat, bukan nilai. Pembagian peran tetap sesuai diskusi awal:
  trigram kuat untuk kode model/part number, vektor kuat untuk deskripsi natural/lintas
  bahasa. Kontrak keluaran tidak berubah: `score` tetap skor trigram (dipakai jalur
  pintas AUTO_MATCH), kandidat jalur vektor membawa skor trigram aslinya yang rendah
  sehingga jalur pintas tetap konservatif.
- **Embedding via endpoint embeddings OpenRouter** (`embeddingService.js`) — model
  `openai/text-embedding-3-large` dipangkas ke **1024 dimensi** lewat param `dimensions`
  (bukan 3072 bawaan, karena index HNSW pgvector maksimal 2000 dimensi; sudah
  diverifikasi OpenRouter meneruskan param ini). API key yang sama dengan LLM — tidak
  ada kredensial/provider baru. Sempat dipertimbangkan Ollama lokal, ditolak user
  ("lebih bersih" tanpa service lokal). PENTING: dimensi kolom `vector(1024)` terkunci
  ke pilihan model — ganti model = ubah kolom + `npm run embed -- --all` + ukur ulang
  `VECTOR_MIN_SIM`. Teks yang di-embed = `name | brand | category`
  (`productEmbeddingText()`) — WAJIB satu sumber, jangan disalin manual.
- **Embedding harus tetap segar** — tiga jalur pengisian: `npm run embed` (backfill
  idempotent, hanya baris NULL; `-- --all` untuk paksa semua), otomatis saat
  create/update produk di `productRoutes.js` (hanya kalau name/brand/category berubah —
  edit harga tidak membakar API call), dan gagal-embed TIDAK menggagalkan simpan produk
  (embedding dibiarkan NULL, ditambal backfill). Kalau OpenRouter down saat pencarian,
  `searchProduct()` turun anggun ke trigram-only (log warning), bukan error.
- **`word_similarity()`, BUKAN `similarity()`** (`src/services/searchService.js`). Ini penting
  dan mudah salah: `similarity()` menormalisasi terhadap gabungan trigram kedua string,
  sehingga query pendek yang dicocokkan ke nama produk panjang dihukum berat —
  "MCCB Schneider 100A" vs "MCCB Schneider EZC100F 100A" hanya dapat ~0.6 walaupun jelas
  cocok. `word_similarity` mencari padanan terbaik query di dalam nama produk, jadi tidak
  sensitif terhadap selisih panjang. Jangan diganti balik ke `similarity()` tanpa mengukur ulang.
- **Retrieval-then-rerank benar-benar diimplementasikan** (Layer 1 + Layer 2 dari diskusi PDF):
  hybrid trigram+vektor menyaring top-8 → `rerankCandidates()` di `aiService.js` menyerahkan
  kandidat itu ke LLM untuk dipilih + diberi confidence → user cuma dipanggil kalau LLM pun
  ragu. Konsekuensi penting: **skor retrieval bukan penentu benar/salah**, ia cuma menentukan
  siapa yang masuk daftar kandidat. Ini juga alasan `VECTOR_MIN_SIM` sengaja longgar: barang
  di luar katalog yang domainnya berdekatan boleh lolos jadi kandidat (terukur: "MCCB
  Schneider 100A" menyeret AC 0.35–0.37) — rerank yang menolaknya, lalu jatuh ke internet.
  Terverifikasi 2026-07-14: "casual shoes dark" → rerank confidence 0.5 → tanya user dengan
  pilihan sepatu hitam (aturan "jangan diam-diam memilihkan" tetap bekerja pada kandidat
  jalur vektor); "kertas ukuran folio 80 gram" → confidence 0.95 auto-pilih F4 80gr.
- **Jumlah AI call per baris**: 1 (extract) + 1 embedding query (mikro, ~$0.000001 —
  bukan LLM call) + 1 (rerank, kecuali kena jalur pintas
  `AUTO_MATCH_SCORE`) + 1 lagi hanya kalau SerpAPI jatuh ke jalur organik. Ini KONTRA dengan
  rekomendasi "batch" di Masalah 3 di atas, tapi disengaja: karena loop-nya sudah pasti
  berhenti-jalan menunggu user, batching di depan tidak memberi banyak penghematan sementara
  menambah kompleksitas. Kalau nanti dipakai untuk mode non-interaktif/bulk, evaluasi ulang.
- **Ambang batas keputusan** — semuanya eksplisit di source code, tidak ada yang bersandar
  pada GUC `pg_trgm.*_threshold` milik server Postgres (ini jebakan di versi awal: konstanta
  `NOT_FOUND_SCORE = 0.3` dulunya dead code, karena operator `%` sudah memfilter di 0.3 lebih
  dulu di sisi Postgres):
  - `SEARCH_MIN_SCORE = 0.3` (`searchService.js`) → batas bawah trigram masuk daftar kandidat
  - `VECTOR_MIN_SIM = 0.3` (`searchService.js`) → batas bawah cosine jalur vektor. Tanpa
    floor ini kandidat TIDAK PERNAH kosong (vektor selalu punya "tetangga terdekat") dan
    jalur internet fallback mati diam-diam. Dikalibrasi 2026-07-14 terhadap seed 60 produk:
    lintas bahasa yang benar 0.39–0.60, query non-barang maks 0.26. JANGAN dinaikkan ke 0.4
    demi menyaring barang luar-katalog — kasus lintas bahasa (0.396) ikut mati; angka
    lengkap ada di komentar `searchService.js`. Ukur ulang kalau ganti model embedding.
  - `AUTO_MATCH_SCORE = 0.9` & `AUTO_MATCH_GAP = 0.15` (`priceFinder.js`) → jalur pintas,
    auto-pilih tanpa memanggil LLM sama sekali
  - `RERANK_AUTO_CONFIDENCE = 0.8` (`priceFinder.js`) → confidence LLM minimal untuk auto-pilih
  - **Sudah divalidasi** terhadap 60 produk seed (8 kasus uji, model `openai/gpt-5-mini`, 8/8
    lulus). Confidence terpisah bersih: kasus auto-pilih berkumpul di 0.95–1.0, kasus ambigu
    jatuh di 0.5 — tidak ada yang menggantung dekat 0.8, jadi ambang itu tahan variasi jawaban
    model. Belum divalidasi dengan katalog produksi asli (ribuan SKU) — ulangi pengukuran nanti.
  - Catatan: jalur pintas `AUTO_MATCH_SCORE` praktis TIDAK PERNAH aktif di data nyata, karena
    varian yang mirip selalu berskor berdekatan sehingga tertahan `AUTO_MATCH_GAP`. Jadi
    hitung biaya dengan asumsi **2 LLM call per baris**, bukan 1.
- **ATURAN PROMPT YANG WAJIB DIPERTAHANKAN** di `rerankCandidates()` (`aiService.js`) — aturan
  "jangan diam-diam memilihkan untuk customer". Kalau permintaan tidak menyebut suatu atribut
  (ukuran/warna/merek/kapasitas) dan BEBERAPA kandidat berbeda justru hanya pada atribut itu,
  LLM wajib menurunkan confidence ke ≤0.5 supaya user yang memilih. Tanpa aturan ini, LLM
  (dengan patuh pada aturan "less specific but not contradicting = valid match") akan
  auto-memilih varian pertama dengan confidence 0.9 — terbukti: permintaan "Sepatu Nike Air
  Force 1 Putih" tanpa ukuran langsung dipilihkan Size 41. Ini kesalahan yang mahal dan senyap:
  salah varian = salah harga, tanpa ada yang bertanya. Menurunkan RERANK_AUTO_CONFIDENCE TIDAK
  memperbaikinya — ini bug prompt, bukan bug ambang batas.
- **SerpAPI: engine `google_shopping` lebih dulu**, baru jatuh ke hasil organik + LLM kalau
  Shopping kosong (produk B2B/industrial sering tidak ada di sana). Shopping mengembalikan
  harga terstruktur, jadi LLM tidak perlu menebak harga dari snippet — yang rawan memungut
  harga varian lain atau harga basi. Tetap mengembalikan **daftar** kandidat, bukan auto-pick
  satu harga — sesuai Masalah 6 di atas. Lihat `src/services/internetService.js`.
- **Mekanisme pause/resume**: registry `sessions` di `src/services/priceFinder.js` menyimpan
  Promise resolver per lineIndex. Loop utama (`processPriceFinder`) benar-benar `await` sampai
  user menjawab lewat event Socket.io `user_choice`, baru lanjut ke baris berikutnya. Ini pola
  paling tidak umum di proyek ini — kalau ada bug terkait race condition atau baris "macet",
  cek di sini dulu. Ada tiga pengaman yang WAJIB dipertahankan kalau file ini diutak-atik:
  - **timeout** `ASK_TIMEOUT_MS` (5 menit) per pertanyaan → auto-skip
  - **`cancelSession()`** dipanggil dari handler `disconnecting` saat socket terakhir di room
    itu putus → membebaskan semua resolver yang menunggu
  - **guard `isSessionActive()`** di `start_price_finder` → cegah dua loop paralel dengan
    sessionId sama berebut resolver yang sama

  Tanpa ketiganya, satu tab yang ditutup di tengah modal akan menggantungkan loop selamanya
  dan membocorkan entry Map sampai server restart.
- **Cache per sesi**: baris yang teksnya identik dijawab dari cache — tidak memicu AI call
  atau pertanyaan ulang. Error dan pembatalan sengaja TIDAK di-cache (layak dicoba lagi).
- **Tidak ada penyimpanan hasil proses ke database** — sesuai keputusan "database cuma
  products saja". Hasil akhir cuma dikirim ke client lewat event `done`.
- **Margin (REVISI dari keputusan awal)** — dulu diputuskan "margin tidak dihitung sistem,
  itu manual di luar modul". Sekarang margin dihitung, TAPI hanya untuk barang dari internet:
  harga internet adalah harga MODAL dari supplier, sedangkan harga dari tabel `products`
  sudah harga jual kita sendiri. Menambahkan margin di atas harga database = menghitung untung
  dua kali, jadi kolom margin dikunci (bukan sekadar kosong) untuk baris non-internet.
  `subtotal = qty x harga x (1 + margin/100)`.
  **Rumus ini ada di DUA tempat dan wajib identik**: `subtotalOf()` di `public/index.html`
  dan `subtotalOf()` di `src/utils/excelExport.js`. Kalau salah satu diubah tanpa yang lain,
  angka di layar dan angka di file Excel akan berbeda — dan itu tidak akan terdeteksi
  sampai ada klien yang protes.
- **Tabel hasil bisa diedit** (`public/index.html`): qty, unit, nama, produk, harga, margin.
  Objek di map `hasil` adalah sumber kebenaran tunggal untuk total dan untuk export — sel
  yang diedit menulis langsung ke objek itu. Baris yang sedang diketik sengaja TIDAK
  di-render ulang (cuma sel subtotal + total yang diperbarui), karena render ulang akan
  melemparkan kursor user ke awal sel.
- **Export Excel** (`src/utils/excelExport.js` + `POST /api/export`): subtotal DIHITUNG ULANG
  di server dari qty/harga/margin, tidak menerima nilai jadi dari browser. Baris tanpa harga
  (skipped/not_found/error) subtotalnya dikosongkan, BUKAN nol — kalau dinolkan, total akan
  terlihat rapi padahal quotation-nya bolong.

## 5. Struktur file

```
server.js                       Entry point: Express + Socket.io + endpoint upload file
                                  + POST /api/export (unduh hasil sebagai Excel)
docker-compose.yml               Postgres 17 + pgvector (image pgvector/pgvector:pg17),
                                  port host 5433. Kredensial harus sama dengan
                                  DATABASE_URL di .env.
database/buat_tabel.sql          Schema tabel products + extension pg_trgm & vector
                                  + kolom embedding vector(1024) + index HNSW
database/buat_tabel.js           Schema applier sekali-jalan: baca buat_tabel.sql, kirim ke
                                  Postgres (npm run init-db). Sengaja pakai klien pg mentah,
                                  bukan Sequelize — tabelnya justru belum ada saat ini jalan.
database/koneksi_database.js     Koneksi Sequelize yang dipakai server sepanjang runtime.
database/list_dummy_item.js      60 produk contoh di 6 kategori (footwear, watches,
                                  furniture, ATK, IT equipment, electronics) — bukti
                                  "generic". Data sengaja BERKLASTER (varian mirip: beda
                                  ukuran/warna/kode model) supaya jalur ambigu & LLM rerank
                                  ikut teruji; katalog yang tiap barisnya unik tidak akan
                                  pernah memicu jalur tersebut. Menolak jalan kalau tabel
                                  sudah terisi — pakai `npm run seed -- --reset` untuk
                                  menghapus semua & seed ulang. Lanjutkan dengan
                                  `npm run embed` setelah seed.
database/isi_embedding.js        Backfill kolom embedding (npm run embed). Idempotent:
                                  hanya baris NULL; `-- --all` untuk paksa embed ulang
                                  semua (wajib setelah ganti model embedding atau ubah
                                  productEmbeddingText). Batch 50 teks per request.
src/loadEnv.js                   Muat .env dari root proyek, di-resolve dari lokasi file
                                  (bukan cwd) — supaya script jalan dari direktori mana pun
src/Product.js                   Model Sequelize untuk tabel products
src/services/aiService.js        callLLM(), extractJson(), extractLine() — ambil
                                  {name, qty, unit}; rerankCandidates() — Layer 2,
                                  LLM memilih 1 dari kandidat DB + confidence.
                                  extractJson() WAJIB mengambil struktur yang muncul lebih
                                  dulu (objek ATAU array) — versi lama selalu mencoba objek
                                  dulu, sehingga jawaban array dari internetService gagal
                                  di-parse dan jalur internet mati diam-diam.
src/services/embeddingService.js embedText()/embedTexts() — endpoint embeddings
                                  OpenRouter; productEmbeddingText() — format teks yang
                                  di-embed (SATU sumber untuk backfill & routes);
                                  toVectorLiteral() — format literal pgvector
src/services/searchService.js    searchProduct() — hybrid: trigram word_similarity +
                                  cosine pgvector, digabung RRF, top-8 kandidat.
                                  Degradasi anggun ke trigram-only kalau embedding
                                  gagal. Ambang: SEARCH_MIN_SCORE & VECTOR_MIN_SIM.
src/services/internetService.js  searchInternet() — SerpAPI google_shopping (harga
                                  terstruktur), fallback ke organik+AI; sampai 5 kandidat
                                  supplier, TANPA auto-pick
src/services/priceFinder.js      Loop utama + mekanisme pause/resume (askUser,
                                  resolveUserChoice, cancelSession, isSessionActive,
                                  processLine, processPriceFinder) + cache per sesi
src/handlers.js                  Wiring event Socket.io: start_price_finder, user_choice,
                                  join_session, cancel_session, disconnecting
src/productRoutes.js             REST CRUD tabel products (/api/products) — list+cari+
                                  paginasi, create, update parsial, delete. Pencarian di
                                  sini sengaja pakai ILIKE, BUKAN trigram: ini layar admin,
                                  user mengetik potongan nama yang dia INGAT dan ingin hasil
                                  yang persis mengandung teks itu. Trigram justru akan
                                  memunculkan barang mirip yang tidak dia cari.
                                  Create/update otomatis refreshEmbedding() kalau
                                  name/brand/category berubah; gagal embed tidak
                                  menggagalkan simpan (tambal via npm run embed).
src/utils/fileParser.js          Parse upload Excel/CSV/TXT jadi array baris teks mentah
src/utils/excelExport.js         buildQuotationXlsx() — hasil jadi workbook Excel. Subtotal
                                  DIHITUNG ULANG di sini, tidak menerima nilai jadi dari
                                  browser. Rumusnya harus identik dengan subtotalOf() di
                                  public/index.html.
public/index.html                UI Price Finder: paste/upload, tabel hasil yang BISA DIEDIT
                                  (qty, unit, nama, produk, harga, margin), kolom subtotal +
                                  baris total, tombol download Excel, modal pilihan kandidat
                                  saat "need_input", progress bar, switch tema gelap/terang
public/products.html             UI CRUD katalog produk: cari (debounce), paginasi, tambah/
                                  edit inline di baris tabel, hapus dengan konfirmasi.
                                  Berbagi kunci localStorage tema dengan index.html.
```

## 6. Yang sengaja BELUM dikerjakan (di luar scope prototype ini)

- Autentikasi / multi-user / multi-tenant
- Penyimpanan riwayat proses import (`import_batches`/`import_items` — pernah didesain,
  tidak dipakai di versi ini)
- Feedback loop otomatis dari koreksi user (Layer 3 dari diskusi PDF) — belum ada tabel
  atau logika untuk menyimpan `raw_text ↔ produk yang benar` sebagai data pembelajaran
- Generate PDF quotation — modul ini berhenti di level "hasil pencarian harga per baris",
  belum sampai ke dokumen akhir
- Perhitungan margin/markup — disengaja, itu manual di luar sistem
- ~~Hybrid pg_trgm + pgvector~~ — SUDAH DIKERJAKAN 2026-07-14, lihat bagian 4
- Chunked/batch AI extraction — relevan kalau nanti ada mode non-interaktif/bulk processing

## 7. Kalau melanjutkan development

Pertanyaan yang perlu dijawab dulu sebelum menambah fitur besar:
- Apakah tetap single-tenant selamanya, atau suatu saat perlu multi-user?
- Setelah dites dengan data produk asli, apakah ambang batas skor (`AUTO_MATCH_SCORE`, dst)
  di `priceFinder.js` sudah pas, atau perlu disesuaikan?
- Apakah hasil akhir proses perlu disimpan (riwayat quotation), atau tetap cukup
  session-only seperti sekarang?
