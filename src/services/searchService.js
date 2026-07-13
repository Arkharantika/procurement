import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/koneksi_database.js";

// Batas bawah kandidat yang dianggap layak dipertimbangkan sama sekali.
// Sengaja dipegang di sini (bukan mengandalkan GUC pg_trgm.*_threshold milik
// server Postgres) supaya semua ambang batas modul ini terlihat di source code.
export const SEARCH_MIN_SCORE = 0.3;

// Top-N kandidat dari tabel products.
//
// Memakai word_similarity(query, name), BUKAN similarity(). similarity()
// menormalisasi terhadap gabungan trigram kedua string, jadi query pendek yang
// dicocokkan ke nama panjang dihukum berat: "MCCB Schneider 100A" vs
// "MCCB Schneider EZC100F 100A" hanya dapat ~0.6 walaupun jelas cocok.
// word_similarity mencari padanan terbaik query di dalam name, sehingga tidak
// sensitif terhadap selisih panjang — persis kasus kita.
export async function searchProduct(name, limit = 8) {
  if (!name || !name.trim()) return [];

  const results = await sequelize.query(
    `
    SELECT id, name, brand, category, price, unit,
           word_similarity(:q, name) AS score
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

  // pg mengembalikan NUMERIC dan BIGINT sebagai string. Normalkan di sini supaya
  // pemanggil tidak perlu tahu soal itu.
  return results.map((r) => ({
    ...r,
    id: String(r.id),
    price: r.price === null ? null : Number(r.price),
    score: Number(r.score),
  }));
}
