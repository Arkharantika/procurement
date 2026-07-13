import { searchProduct } from "./searchService.js";
import { searchInternet } from "./internetService.js";
import { extractLine, rerankCandidates } from "./aiService.js";

// ---------------------------------------------------------------------------
// Ambang batas keputusan
// ---------------------------------------------------------------------------
// Alurnya: trigram menyaring kandidat → LLM memilih di antara kandidat itu →
// user cuma dipanggil kalau LLM pun ragu.
//
// AUTO_MATCH_SCORE dipakai sebagai jalur pintas: kalau trigram sudah sangat
// yakin DAN tidak ada saingan dekat, kita lewati LLM sama sekali (hemat 1 API
// call per baris). Selain itu, LLM yang memutuskan.
const AUTO_MATCH_SCORE = 0.9; // skor word_similarity top-1 yang dianggap pasti
const AUTO_MATCH_GAP = 0.15; // selisih minimal ke skor ke-2 supaya tidak ambigu
const RERANK_AUTO_CONFIDENCE = 0.8; // confidence LLM minimal untuk auto-pilih

// Berapa lama menunggu jawaban user sebelum baris ini dilewati otomatis.
// Tanpa ini, satu tab yang ditutup di tengah modal akan menggantung loop selamanya.
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Registry sesi + mekanisme pause/resume
// ---------------------------------------------------------------------------
// Satu entry per sesi yang sedang berjalan. `pending` menyimpan resolver Promise
// per lineIndex — inilah yang membuat loop utama bisa benar-benar berhenti
// menunggu user. Struktur bersarang (bukan key gabungan `sessionId_lineIndex`)
// supaya membersihkan satu sesi tidak perlu menebak-nebak prefix string.
const sessions = new Map(); // sessionId -> { cancelled, pending: Map<lineIndex, {resolve, timer}> }

export function isSessionActive(sessionId) {
  return sessions.has(sessionId);
}

// Dipanggil dari socket handler saat client mengirim "user_choice".
// Mengembalikan true kalau ada yang berhasil di-resolve, false kalau tidak
// (misal user menjawab untuk baris yang sudah tidak ditunggu lagi).
export function resolveUserChoice(sessionId, lineIndex, choice) {
  const session = sessions.get(sessionId);
  const entry = session?.pending.get(lineIndex);
  if (!entry) return false;

  clearTimeout(entry.timer);
  session.pending.delete(lineIndex);
  entry.resolve(choice);
  return true;
}

// Dipanggil saat client putus / sesi dibatalkan. Membebaskan semua baris yang
// sedang menunggu supaya loop-nya bisa keluar, bukan menggantung selamanya.
export function cancelSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.cancelled = true;
  for (const [lineIndex, entry] of session.pending) {
    clearTimeout(entry.timer);
    entry.resolve({ type: "cancel" });
    session.pending.delete(lineIndex);
  }
  return true;
}

function askUser(io, session, sessionId, payload) {
  return new Promise((resolve) => {
    const { lineIndex } = payload;

    const timer = setTimeout(() => {
      session.pending.delete(lineIndex);
      io.to(sessionId).emit("input_timeout", { lineIndex });
      resolve({ type: "skip", reason: "timeout" });
    }, ASK_TIMEOUT_MS);

    session.pending.set(lineIndex, { resolve, timer });
    io.to(sessionId).emit("need_input", payload);
  });
}

// ---------------------------------------------------------------------------
// Pemrosesan satu baris
// ---------------------------------------------------------------------------

function resolveChoiceToResult(choice, base, candidates) {
  if (choice?.type === "cancel") {
    return { ...base, product: null, price: null, source: "cancelled" };
  }

  if (!choice || choice.type === "skip") {
    return { ...base, product: null, price: null, source: "skipped" };
  }

  if (choice.type === "product") {
    // id dari client datang lewat JSON — bandingkan sebagai string, karena
    // BIGINT dari Postgres juga string.
    const product = candidates.find((c) => String(c.id) === String(choice.id));
    return {
      ...base,
      product: product || null,
      price: product?.price ?? null,
      source: "user_selected_db",
    };
  }

  if (choice.type === "internet") {
    const item = candidates.find((c) => c.url === choice.url);
    return {
      ...base,
      product: item
        ? { name: item.title || base.name, supplier: item.supplier, url: item.url }
        : null,
      price: item?.price ?? null,
      source: "user_selected_internet",
    };
  }

  return { ...base, product: null, price: null, source: "unknown" };
}

async function askInternet(io, session, sessionId, base) {
  const internetResults = await searchInternet(base.name);

  if (internetResults.length === 0) {
    return { ...base, product: null, price: null, source: "not_found" };
  }

  // PAUSE — SerpAPI sengaja mengembalikan daftar kandidat, user yang memilih.
  const choice = await askUser(io, session, sessionId, {
    ...base,
    reason: "internet_fallback",
    candidates: internetResults,
  });
  return resolveChoiceToResult(choice, base, internetResults);
}

async function processLine(io, session, sessionId, lineIndex, rawText) {
  const { name, qty, unit } = await extractLine(rawText);
  const base = { lineIndex, rawText, name, qty, unit };

  const candidates = await searchProduct(name);

  // Tidak ada satu pun kandidat yang lolos ambang bawah → langsung ke internet.
  if (candidates.length === 0) {
    return askInternet(io, session, sessionId, base);
  }

  const [best, second] = candidates;

  // Jalur pintas: trigram sudah sangat yakin dan tidak ada saingan dekat.
  const isObviousMatch =
    best.score >= AUTO_MATCH_SCORE &&
    (!second || best.score - second.score >= AUTO_MATCH_GAP);

  if (isObviousMatch) {
    return { ...base, product: best, price: best.price, source: "auto_database" };
  }

  // Selain itu: biarkan LLM yang membaca kandidatnya dan memutuskan.
  const verdict = await rerankCandidates(name, candidates);

  if (verdict.id && verdict.confidence >= RERANK_AUTO_CONFIDENCE) {
    const picked = candidates.find((c) => String(c.id) === String(verdict.id));
    if (picked) {
      return {
        ...base,
        product: picked,
        price: picked.price,
        source: "auto_database_ai",
        confidence: verdict.confidence,
        reason: verdict.reason,
      };
    }
  }

  // LLM yakin tidak ada yang cocok → cari di internet.
  if (!verdict.id) {
    return askInternet(io, session, sessionId, base);
  }

  // LLM punya tebakan tapi tidak cukup yakin → PAUSE, user yang memutuskan.
  // Kandidat tebakan LLM diangkat ke urutan pertama supaya user tidak perlu mencari.
  const ordered = [
    ...candidates.filter((c) => String(c.id) === String(verdict.id)),
    ...candidates.filter((c) => String(c.id) !== String(verdict.id)),
  ];

  const choice = await askUser(io, session, sessionId, {
    ...base,
    reason: "ambiguous",
    suggestedId: verdict.id,
    suggestionReason: verdict.reason,
    candidates: ordered,
  });
  return resolveChoiceToResult(choice, base, ordered);
}

// ---------------------------------------------------------------------------
// Loop utama
// ---------------------------------------------------------------------------
// Jalan satu baris pada satu waktu, betul-betul menunggu jawaban user sebelum
// lanjut ke baris berikutnya (kalau memang perlu tanya).
export async function processPriceFinder(io, sessionId, lines) {
  if (sessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} is already running`);
  }

  const session = { cancelled: false, pending: new Map() };
  sessions.set(sessionId, session);

  const results = [];
  // Quotation sering memuat item yang sama berulang kali. Tanpa cache, tiap
  // duplikat = 1 AI call + 1 pause baru untuk pertanyaan yang persis sama.
  const cache = new Map(); // rawText (ternormalisasi) -> hasil, tanpa lineIndex

  try {
    for (let i = 0; i < lines.length; i++) {
      if (session.cancelled) break;

      const rawText = lines[i];
      if (!rawText || !rawText.trim()) continue;

      io.to(sessionId).emit("line_start", { lineIndex: i, rawText });

      let result;
      const cacheKey = rawText.trim().toLowerCase();

      try {
        if (cache.has(cacheKey)) {
          result = { ...cache.get(cacheKey), lineIndex: i, rawText, cached: true };
        } else {
          result = await processLine(io, session, sessionId, i, rawText);

          // Jangan cache error atau pembatalan — keduanya bukan keputusan yang
          // sengaja diambil user, dan layak dicoba lagi.
          if (result.source !== "error" && result.source !== "cancelled") {
            const { lineIndex, rawText: _rt, ...reusable } = result;
            cache.set(cacheKey, reusable);
          }
        }
      } catch (err) {
        result = { lineIndex: i, rawText, error: err.message, source: "error" };
      }

      results.push(result);
      io.to(sessionId).emit("line_done", result);
    }

    io.to(sessionId).emit("done", { results, cancelled: session.cancelled });
    return results;
  } finally {
    // Apa pun yang terjadi (selesai, error, dibatalkan) — bersihkan.
    // Tanpa ini, setiap sesi yang putus di tengah meninggalkan entry permanen.
    for (const entry of session.pending.values()) clearTimeout(entry.timer);
    sessions.delete(sessionId);
  }
}
