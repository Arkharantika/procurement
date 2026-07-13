-- EstimaCore PriceFinder — schema minimal
-- Cukup satu tabel: products. Generic lintas bidang (tidak ada kolom spesifik industri).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS products (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    brand       VARCHAR(150),
    category    VARCHAR(150),
    price       NUMERIC(15,2),
    unit        VARCHAR(50) DEFAULT 'pcs',
    created_at  TIMESTAMPTZ DEFAULT now()
);

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
