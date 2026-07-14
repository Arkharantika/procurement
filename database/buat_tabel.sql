-- EstimaCore PriceFinder — schema minimal
-- Cukup satu tabel: products. Generic lintas bidang (tidak ada kolom spesifik industri).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- vector = pgvector. Tersedia bawaan di image Docker pgvector/pgvector:pg17
-- (Postgres Windows biasa TIDAK membawanya — itu alasan pindah ke Docker).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS products (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    brand       VARCHAR(150),
    category    VARCHAR(150),
    price       NUMERIC(15,2),
    unit        VARCHAR(50) DEFAULT 'pcs',
    created_at  TIMESTAMPTZ DEFAULT now(),
    -- Vektor semantik dari name+brand+category, diisi lewat `npm run embed`
    -- (atau otomatis saat produk dibuat/diedit via API). Dimensi 1024 TERKUNCI
    -- ke model openai/text-embedding-3-large dengan param dimensions:1024 di
    -- embeddingService.js — ganti model embedding = ubah dimensi kolom ini
    -- + jalankan ulang `npm run embed -- --all`. Vektor model berbeda TIDAK
    -- boleh dicampur dalam satu kolom: jaraknya jadi tak bermakna.
    embedding   vector(1024)
);

-- Untuk database yang tabelnya sudah terlanjur ada sebelum kolom embedding
-- diperkenalkan (CREATE TABLE IF NOT EXISTS di atas tidak menambah kolom baru).
ALTER TABLE products ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
    ON products USING GIN (name gin_trgm_ops);

-- Catatan soal index di atas:
-- searchService.js memfilter dengan `word_similarity(:q, name) >= 0.3`, yaitu
-- perbandingan numerik biasa — bukan operator, jadi TIDAK memakai index ini dan
-- akan seq scan. Di skala prototype (ribuan baris) itu tidak masalah, dan
-- imbalannya semua ambang batas terlihat eksplisit di source code.
--
-- Kalau katalog sudah puluhan ribu baris ke atas, ganti WHERE-nya jadi operator
-- `:q <% name` (baru index ini terpakai) dan set ambangnya lewat:
--   SET pg_trgm.word_similarity_threshold = 0.3;

-- Index HNSW untuk pencarian vektor (cosine). Catatan: HNSW pgvector maksimal
-- 2000 dimensi — itu salah satu alasan embedding dipangkas ke 1024 (bukan 3072
-- bawaan text-embedding-3-large). Di skala prototype index ini belum terasa,
-- tapi murah dipasang sekarang dan otomatis terpakai saat katalog membesar.
CREATE INDEX IF NOT EXISTS idx_products_embedding_hnsw
    ON products USING hnsw (embedding vector_cosine_ops);
