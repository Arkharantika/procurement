import "../loadEnv.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Model diatur lewat OPENROUTER_MODEL di .env — kode ini tidak terikat ke satu
// provider. OpenRouter memakai antarmuka chat/completions yang sama untuk semua
// model, jadi berpindah provider cukup dengan mengganti string ini.
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5-mini";

// WAJIB diisi. Kalau max_tokens dibiarkan kosong, OpenRouter memakai batas maksimum
// model (puluhan ribu token) dan MENCADANGKAN kredit sebanyak itu di muka — request
// langsung ditolak 402 kalau saldo tidak cukup, walaupun jawaban aslinya cuma
// beberapa ratus token. Semua output modul ini berupa JSON pendek, jadi 2000 lebih
// dari cukup; angka ini juga jadi pagar biaya kalau model mengoceh panjang.
const MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS) || 2000;

export async function callLLM(messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://estimacore.local",
      "X-Title": "EstimaCore PriceFinder",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      // Tugas di sini sederhana (ekstraksi + pilih 1 dari daftar). Pada model
      // reasoning (seri gpt-5.x, o-series), reasoning token ikut dihitung sebagai
      // output — effort rendah menahan biaya tanpa merugikan akurasi tugas ini.
      // Model non-reasoning mengabaikan field ini.
      reasoning: { effort: "low" },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error: ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export function extractJson(raw) {
  const codeBlock =
    raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/);
  const text = (codeBlock ? codeBlock[1] : raw).trim();

  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");

  // Ambil struktur yang muncul LEBIH DULU, jangan selalu objek.
  //
  // Versi lama mencoba pola objek /\{[\s\S]*\}/ terlebih dulu. Untuk jawaban berupa
  // array — yang justru kita minta di internetService — potongannya jadi
  // `{...},{...}` tanpa kurung siku: JSON tidak valid, parse gagal, hasil dibuang
  // diam-diam. Akibatnya jalur pencarian internet tidak pernah mengembalikan apa pun.
  let start, closer;
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) {
    start = arrAt;
    closer = "]";
  } else if (objAt !== -1) {
    start = objAt;
    closer = "}";
  } else {
    return JSON.parse(text);
  }

  return JSON.parse(text.slice(start, text.lastIndexOf(closer) + 1));
}

// Ekstrak nama produk + qty + unit dari satu baris teks bebas.
// Sengaja domain-agnostic — tidak boleh berasumsi kategori barang tertentu.
export async function extractLine(rawText) {
  const raw = await callLLM([
    {
      role: "user",
      content: `Extract the product name, quantity, and unit from this order line.
The product can be from ANY business category (electrical, furniture, office supplies, food, electronics, etc) - do not assume a specific domain.

Line: "${rawText}"

Rules:
- "name": clean product name/description, keep brand and key specs, remove quantity/unit words
- "qty": numeric quantity, default to 1 if not mentioned
- "unit": unit of measurement (pcs, box, kg, meter, etc), default to "pcs" if not mentioned

Reply ONLY as raw JSON, no markdown:
{"name":"...", "qty": 0, "unit":"..."}`,
    },
  ]);

  try {
    const parsed = extractJson(raw);
    return {
      name: parsed.name || rawText,
      qty: Number(parsed.qty) || 1,
      unit: parsed.unit || "pcs",
    };
  } catch {
    // Fallback aman kalau AI gagal parse — proses tetap lanjut
    return { name: rawText, qty: 1, unit: "pcs" };
  }
}

// Layer 2 dari arsitektur retrieval-then-rerank: trigram sudah mempersempit ke
// segelintir kandidat, sekarang LLM yang memilih di antara kandidat itu.
//
// Ini yang membuat kita tidak perlu menebak-nebak ambang batas skor trigram:
// skor trigram cuma dipakai untuk menyaring, keputusan cocok/tidak diserahkan ke
// model yang benar-benar "membaca" nama produknya.
//
// Mengembalikan { id, confidence, reason }. id = null berarti tidak ada kandidat
// yang benar-benar cocok (lanjut ke pencarian internet).
export async function rerankCandidates(queryName, candidates) {
  if (!candidates || candidates.length === 0) {
    return { id: null, confidence: 0, reason: "no_candidates" };
  }

  const list = candidates
    .map(
      (c) =>
        `- id=${c.id} | ${c.name}${c.brand ? ` | brand: ${c.brand}` : ""}${
          c.category ? ` | category: ${c.category}` : ""
        }`
    )
    .join("\n");

  const raw = await callLLM([
    {
      role: "user",
      content: `You are matching a customer's requested item against a product catalog.
The products can be from ANY business category - do not assume a specific domain.

Requested item: "${queryName}"

Catalog candidates:
${list}

Pick the ONE candidate that is genuinely the same product as the requested item.

Rules:
- Model numbers, part numbers, ratings and sizes must not contradict each other. A different rating or model is a DIFFERENT product, even if the names look similar.
- CRITICAL — do not silently choose for the customer. If the request leaves out an attribute (size, colour, brand, capacity, weight...) and SEVERAL candidates differ from each other only on that attribute, then those candidates are all equally valid and you cannot know which one is wanted. Still pick the most likely, but you MUST set confidence at 0.5 or below so a human is asked to choose. Shipping size 41 to someone who never said "41" is a real, expensive mistake.
- A candidate carrying extra descriptive detail that does NOT create a competing alternative (e.g. "6 inch", "Split Standard") is not ambiguity — confidence can stay high.
- If no candidate is genuinely the same product, return id null. Do NOT force a match.
- "confidence" is how sure you are that this pick is THE product the customer wants, from 0.0 to 1.0.

Reply ONLY as raw JSON, no markdown:
{"id": <candidate id or null>, "confidence": 0.0, "reason": "short reason"}`,
    },
  ]);

  try {
    const parsed = extractJson(raw);
    const rawId = parsed?.id;

    if (rawId === null || rawId === undefined || rawId === "" || rawId === "null") {
      return { id: null, confidence: 0, reason: parsed?.reason || "no_match" };
    }

    // Jangan percaya begitu saja — pastikan id-nya memang salah satu kandidat
    // yang kita kirim, bukan halusinasi.
    const match = candidates.find((c) => String(c.id) === String(rawId));
    if (!match) {
      return { id: null, confidence: 0, reason: "id_not_in_candidates" };
    }

    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    return { id: match.id, confidence, reason: parsed.reason || "" };
  } catch {
    // Kalau rerank gagal, jangan gagalkan barisnya — biarkan user yang memutuskan.
    return { id: null, confidence: 0, reason: "rerank_failed" };
  }
}
