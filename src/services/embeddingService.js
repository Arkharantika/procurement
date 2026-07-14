import "../loadEnv.js";

// Lapisan embedding untuk pencarian vektor (pgvector). Dipakai di tiga tempat:
// backfill sekali-jalan (npm run embed), re-embed saat produk dibuat/diedit
// (productRoutes.js), dan meng-embed query di setiap pencarian (searchService.js).
//
// Endpoint embeddings OpenRouter — format OpenAI-compatible, API key yang sama
// dengan callLLM() di aiService.js. Sengaja provider yang sama supaya tidak ada
// dependency/kredensial baru.
const OPENROUTER_EMB_URL = "https://openrouter.ai/api/v1/embeddings";

// Model harus MULTIBAHASA — kasus pemicu fitur ini adalah query Inggris
// ("casual shoes dark") terhadap katalog berbahasa Indonesia ("Sepatu ... Hitam").
const EMBEDDING_MODEL =
  process.env.OPENROUTER_EMBEDDING_MODEL || "openai/text-embedding-3-large";

// TERKUNCI ke vector(1024) di buat_tabel.sql. 1024 dipilih (bukan 3072 bawaan
// 3-large) karena index HNSW pgvector maksimal 2000 dimensi; model seri
// text-embedding-3 mendukung pemangkasan lossy-minimal lewat param `dimensions`
// (sudah diverifikasi diteruskan dengan benar oleh OpenRouter). Konsekuensi:
// kalau OPENROUTER_EMBEDDING_MODEL diganti, model barunya juga HARUS mendukung
// param dimensions=1024 — atau ubah dimensi kolomnya dan backfill ulang.
export const EMBEDDING_DIM = 1024;

// Teks yang di-embed untuk satu produk. Dipakai backfill DAN productRoutes —
// jangan disalin manual di tempat lain: kalau formatnya menyimpang antara isi
// katalog dan query, kualitas pencarian turun diam-diam tanpa error.
// Category ikut disertakan karena menambah sinyal semantik (kebetulan juga
// berbahasa Inggris di seed — membantu query lintas bahasa).
export function productEmbeddingText({ name, brand, category }) {
  return [name, brand, category].filter(Boolean).join(" | ");
}

// Format literal vektor pgvector: '[0.1,0.2,...]' — dikirim sebagai string lalu
// di-cast ::vector di SQL. Driver pg tidak mengenal tipe vector secara native.
export function toVectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

// Embed banyak teks sekaligus (satu HTTP request). Endpoint menerima array —
// dipakai backfill supaya 60+ produk tidak jadi 60+ request.
// Melempar error kalau gagal; PEMANGGIL yang memutuskan nasibnya:
// searchService menangkap dan turun ke trigram-only, productRoutes menangkap
// dan membiarkan embedding NULL (ditambal `npm run embed`), backfill membiarkan
// prosesnya berhenti dengan pesan jelas.
export async function embedTexts(texts) {
  const res = await fetch(OPENROUTER_EMB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://estimacore.local",
      "X-Title": "EstimaCore PriceFinder",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter embeddings error: ${await res.text()}`);
  }

  const json = await res.json();
  // Urutan data mengikuti urutan input, tapi jangan bergantung pada asumsi itu —
  // field index resmi ada di respons, pakai itu.
  const out = new Array(texts.length);
  for (const item of json.data) out[item.index] = item.embedding;
  return out;
}

export async function embedText(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}
