import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/koneksi_database.js";
import { embedText, toVectorLiteral } from "./embeddingService.js";

// Batas bawah kandidat trigram yang dianggap layak dipertimbangkan sama sekali.
// Sengaja dipegang di sini (bukan mengandalkan GUC pg_trgm.*_threshold milik
// server Postgres) supaya semua ambang batas modul ini terlihat di source code.
export const SEARCH_MIN_SCORE = 0.3;

// Batas bawah cosine similarity untuk jalur vektor. PENTING dan mudah terlewat:
// pencarian vektor SELALU punya "tetangga terdekat" — query sampah sekalipun
// mengembalikan sesuatu. Tanpa ambang ini daftar kandidat tidak pernah kosong,
// artinya jalur internet fallback di priceFinder MATI DIAM-DIAM.
// Nilai 0.30 hasil kalibrasi terhadap seed 60 produk (text-embedding-3-large
// @1024 dim, diukur 2026-07-14):
//   - lintas bahasa yang benar: "casual shoes dark" -> sepatu hitam 0.385-0.396,
//     "black office chair" -> kursi kantor 0.57, "kertas folio 80 gram" -> F4 80gr 0.60
//   - query non-barang: "jasa konsultasi pajak" maks 0.263, "pisang goreng keju"
//     maks 0.241 -> tersaring bersih
//   - JANGAN dinaikkan ke 0.4 demi menyaring lebih ketat: kasus lintas bahasa di
//     atas ikut mati (0.396 < 0.4). Barang di luar katalog yang domainnya
//     berdekatan memang bisa lolos floor (terukur: "MCCB Schneider 100A" menyeret
//     AC 0.35-0.37) — menolaknya adalah tugas LLM rerank (Layer 2), bukan tugas
//     retrieval; trigram lama pun bocor serupa (kasus Garmin, 0.33).
// Ukur ulang kalau ganti model embedding — skala cosine antar model TIDAK
// sebanding.
export const VECTOR_MIN_SIM = 0.3;

// Konstanta Reciprocal Rank Fusion (nilai standar dari papernya). Skor trigram
// (word_similarity) dan cosine (vektor) tidak bisa dibandingkan langsung —
// skalanya beda makna — jadi penggabungan dilakukan lewat PERINGKAT di
// masing-masing daftar: skor akhir = Σ 1/(k + peringkat).
const RRF_K = 60;

// Top-N kandidat dari tabel products — Layer 1 (fast retrieval) dari arsitektur
// retrieval-then-rerank. Hybrid: trigram (kuat untuk kode model/part number,
// toleran typo) + vektor pgvector (kuat untuk deskripsi natural & lintas bahasa),
// digabung dengan RRF.
//
// Kontrak untuk pemanggil TIDAK berubah dari versi trigram-only:
// - `score` tetap word_similarity trigram (0..1) — jalur pintas AUTO_MATCH_SCORE
//   di priceFinder.js membacanya. Kandidat yang masuk lewat jalur vektor saja
//   membawa skor trigram aslinya yang rendah, sehingga jalur pintas tetap
//   konservatif (tidak pernah auto-match dari kemiripan semantik belaka).
// - Urutan daftar sekarang berdasarkan RRF, bukan skor trigram murni.
//
// Soal trigram: memakai word_similarity(query, name), BUKAN similarity().
// similarity() menormalisasi terhadap gabungan trigram kedua string, jadi query
// pendek yang dicocokkan ke nama panjang dihukum berat: "MCCB Schneider 100A" vs
// "MCCB Schneider EZC100F 100A" hanya dapat ~0.6 walaupun jelas cocok.
// word_similarity mencari padanan terbaik query di dalam name — persis kasus kita.
export async function searchProduct(name, limit = 8) {
  if (!name || !name.trim()) return [];

  // Embed query dulu. Kalau gagal (OpenRouter down, kuota habis), JANGAN
  // mematikan pencarian — turun ke trigram-only. Lebih baik hasil menyempit
  // daripada seluruh baris error.
  let emb = null;
  try {
    emb = toVectorLiteral(await embedText(name));
  } catch (err) {
    console.warn(`[searchService] embedding gagal, turun ke trigram-only: ${err.message}`);
  }

  const results = emb
    ? await hybridSearch(name, emb, limit)
    : await trigramSearch(name, limit);

  // pg mengembalikan NUMERIC dan BIGINT sebagai string. Normalkan di sini supaya
  // pemanggil tidak perlu tahu soal itu.
  return results.map((r) => ({
    ...r,
    id: String(r.id),
    price: r.price === null ? null : Number(r.price),
    score: Number(r.score),
    vector_sim: Number(r.vector_sim || 0),
  }));
}

async function hybridSearch(name, emb, limit) {
  return sequelize.query(
    `
    WITH trgm AS (
      SELECT id,
             row_number() OVER (
               ORDER BY word_similarity(:q, name) DESC, length(name) ASC
             ) AS rn
      FROM products
      WHERE word_similarity(:q, name) >= :minScore
      ORDER BY word_similarity(:q, name) DESC, length(name) ASC
      LIMIT :limit
    ),
    vec AS (
      SELECT id,
             1 - (embedding <=> :emb::vector) AS sim,
             row_number() OVER (ORDER BY embedding <=> :emb::vector ASC) AS rn
      FROM products
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> :emb::vector) >= :vecMin
      ORDER BY embedding <=> :emb::vector ASC
      LIMIT :limit
    )
    SELECT p.id, p.name, p.brand, p.category, p.price, p.unit,
           word_similarity(:q, p.name)     AS score,
           COALESCE(v.sim, 0)              AS vector_sim,
           COALESCE(1.0 / (:rrfK + t.rn), 0)
             + COALESCE(1.0 / (:rrfK + v.rn), 0) AS rrf
    FROM trgm t
    FULL OUTER JOIN vec v ON v.id = t.id
    JOIN products p ON p.id = COALESCE(t.id, v.id)
    ORDER BY rrf DESC, length(p.name) ASC
    LIMIT :limit
    `,
    {
      replacements: {
        q: name,
        emb,
        limit,
        minScore: SEARCH_MIN_SCORE,
        vecMin: VECTOR_MIN_SIM,
        rrfK: RRF_K,
      },
      type: QueryTypes.SELECT,
    }
  );
}

// Jalur darurat saat embedding tidak tersedia — persis perilaku versi
// trigram-only sebelum hybrid.
async function trigramSearch(name, limit) {
  return sequelize.query(
    `
    SELECT id, name, brand, category, price, unit,
           word_similarity(:q, name) AS score,
           0 AS vector_sim
    FROM products
    WHERE word_similarity(:q, name) >= :minScore
    ORDER BY score DESC, length(name) ASC
    LIMIT :limit
    `,
    {
      replacements: { q: name, limit, minScore: SEARCH_MIN_SCORE },
      type: QueryTypes.SELECT,
    }
  );
}
