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
  name, brand, category, price, unit. Sengaja tidak ada kolom atribut spesifik domain.
- **pg_trgm, bukan pgvector** — untuk prototype ini dipilih karena lebih simpel untuk
  dijalankan (tidak butuh model embedding terpisah) dan cukup baik untuk data yang belum
  terlalu besar. Catatan dari diskusi: pgvector lebih unggul untuk deskripsi natural,
  sedangkan pg_trgm sering lebih baik untuk kode model/part number yang maknanya lemah
  secara semantik tapi kuat secara karakter. Untuk versi produksi dengan katalog besar,
  pertimbangkan hybrid (pg_trgm + pgvector).
- **`word_similarity()`, BUKAN `similarity()`** (`src/services/searchService.js`). Ini penting
  dan mudah salah: `similarity()` menormalisasi terhadap gabungan trigram kedua string,
  sehingga query pendek yang dicocokkan ke nama produk panjang dihukum berat —
  "MCCB Schneider 100A" vs "MCCB Schneider EZC100F 100A" hanya dapat ~0.6 walaupun jelas
  cocok. `word_similarity` mencari padanan terbaik query di dalam nama produk, jadi tidak
  sensitif terhadap selisih panjang. Jangan diganti balik ke `similarity()` tanpa mengukur ulang.
- **Retrieval-then-rerank benar-benar diimplementasikan** (Layer 1 + Layer 2 dari diskusi PDF):
  trigram menyaring top-8 → `rerankCandidates()` di `aiService.js` menyerahkan kandidat itu ke
  LLM untuk dipilih + diberi confidence → user cuma dipanggil kalau LLM pun ragu. Konsekuensi
  penting: **skor trigram bukan lagi penentu benar/salah**, ia cuma menentukan siapa yang masuk
  daftar kandidat. Jadi tidak perlu lagi menebak-nebak angka ambang batas seperti versi awal.
- **Jumlah AI call per baris**: 1 (extract) + 1 (rerank, kecuali kena jalur pintas
  `AUTO_MATCH_SCORE`) + 1 lagi hanya kalau SerpAPI jatuh ke jalur organik. Ini KONTRA dengan
  rekomendasi "batch" di Masalah 3 di atas, tapi disengaja: karena loop-nya sudah pasti
  berhenti-jalan menunggu user, batching di depan tidak memberi banyak penghematan sementara
  menambah kompleksitas. Kalau nanti dipakai untuk mode non-interaktif/bulk, evaluasi ulang.
- **Ambang batas keputusan** — semuanya eksplisit di source code, tidak ada yang bersandar
  pada GUC `pg_trgm.*_threshold` milik server Postgres (ini jebakan di versi awal: konstanta
  `NOT_FOUND_SCORE = 0.3` dulunya dead code, karena operator `%` sudah memfilter di 0.3 lebih
  dulu di sisi Postgres):
  - `SEARCH_MIN_SCORE = 0.3` (`searchService.js`) → batas bawah masuk daftar kandidat
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
database/buat_tabel.sql          Schema tabel products + extension pg_trgm
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
                                  menghapus semua & seed ulang.
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
src/services/searchService.js    searchProduct() — query pg_trgm word_similarity,
                                  top-8 kandidat + score
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
- Hybrid pg_trgm + pgvector — evaluasi ulang kalau katalog produk sudah besar
  (puluhan ribu+) atau deskripsi produk sangat bervariasi secara natural language
- Chunked/batch AI extraction — relevan kalau nanti ada mode non-interaktif/bulk processing

## 7. Kalau melanjutkan development

Pertanyaan yang perlu dijawab dulu sebelum menambah fitur besar:
- Apakah tetap single-tenant selamanya, atau suatu saat perlu multi-user?
- Setelah dites dengan data produk asli, apakah ambang batas skor (`AUTO_MATCH_SCORE`, dst)
  di `priceFinder.js` sudah pas, atau perlu disesuaikan?
- Apakah hasil akhir proses perlu disimpan (riwayat quotation), atau tetap cukup
  session-only seperti sekarang?
