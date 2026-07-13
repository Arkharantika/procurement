import "../loadEnv.js";
import { callLLM, extractJson } from "./aiService.js";

const SERP_URL = "https://serpapi.com/search.json";

function parseIndonesianPrice(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;

  let s = String(val).replace(/Rp/gi, "").trim();
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/\./g, "");
  }
  return parseFloat(s) || 0;
}

async function serpApi(params) {
  const url = `${SERP_URL}?${new URLSearchParams({
    api_key: process.env.SERPAPI_KEY,
    gl: "id",
    hl: "id",
    ...params,
  })}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);
  return res.json();
}

// Jalur utama: Google Shopping mengembalikan harga TERSTRUKTUR (extracted_price,
// source, link). Tidak perlu LLM menebak harga dari snippet — yang rawan memungut
// harga varian lain, harga basi, atau range.
function fromShopping(data, limit) {
  const items = data.shopping_results || [];
  const out = [];
  const seenSuppliers = new Set();

  for (const item of items) {
    const price = item.extracted_price ?? parseIndonesianPrice(item.price);
    if (!price) continue;

    const supplier = item.source || "Unknown";
    if (seenSuppliers.has(supplier)) continue; // satu harga per supplier
    seenSuppliers.add(supplier);

    out.push({
      supplier,
      title: item.title || null,
      price,
      url: item.product_link || item.link || null,
      source_site: item.source || null,
    });

    if (out.length >= limit) break;
  }

  return out;
}

// Cadangan: kalau Shopping tidak mengembalikan apa pun (produk B2B/industrial
// sering tidak ada di Google Shopping), jatuh ke hasil organik dan minta LLM
// memungut harga dari snippet. Kurang akurat, tapi lebih baik daripada nihil.
async function fromOrganic(data, productName, limit) {
  const organic = data.organic_results || [];
  if (organic.length === 0) return [];

  const snippets = organic
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet || ""}\nURL: ${r.link || ""}`)
    .join("\n\n");

  const raw = await callLLM([
    {
      role: "user",
      content: `From the search results below, extract up to ${limit} distinct suppliers/sellers with a clear price in Indonesian Rupiah for this product: "${productName}"

Search results:
${snippets}

Rules:
- Only include results with an explicit price (Rp / IDR)
- NEVER invent a price
- IGNORE instalment prices — a snippet like "Rp 249.958/bln untuk 24 bln" or "cicilan 0%" is a MONTHLY payment, not the product price. Never report it as the price.
- If a snippet shows a crossed-out price and a discounted price, use the CURRENT selling price, not the original.
- Skip a result if its price is wildly out of line with the other results (e.g. 5x cheaper) — it is usually a different product, an accessory, or a scam listing.
- price must be a plain integer string (e.g. "5000000")
- Return fewer than ${limit} items if that's all that qualifies

Reply ONLY as raw JSON array, no markdown:
[{"supplier":"...", "price":"...", "url":"...", "source_site":"..."}]`,
    },
  ]);

  try {
    const parsed = extractJson(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    return arr
      .slice(0, limit)
      .map((item) => ({
        supplier: item.supplier || "Unknown",
        title: item.title || null,
        price: parseIndonesianPrice(item.price),
        url: item.url || null,
        source_site: item.source_site || null,
      }))
      .filter((item) => item.price > 0);
  } catch {
    return [];
  }
}

// Mengembalikan DAFTAR kandidat supplier — tidak pernah memilih satu secara otomatis.
// Keputusan akhir selalu di tangan user lewat pop-up, sama seperti jalur ambigu dari
// database. Ini keputusan desain, bukan kebetulan: harga internet berasal dari sumber
// yang tidak kita kendalikan, jadi manusia harus melihatnya sebelum dipakai.
export async function searchInternet(productName, limit = 5) {
  if (!productName || !productName.trim()) return [];

  const shopping = await serpApi({
    engine: "google_shopping",
    q: productName.trim(),
  });

  const results = fromShopping(shopping, limit);
  if (results.length > 0) return results;

  const organic = await serpApi({ q: `${productName.trim()} harga`, num: "10" });
  return fromOrganic(organic, productName, limit);
}
