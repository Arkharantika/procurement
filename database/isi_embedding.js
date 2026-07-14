import "../src/loadEnv.js";
import { QueryTypes } from "sequelize";
import { sequelize } from "./koneksi_database.js";
import {
  embedTexts,
  productEmbeddingText,
  toVectorLiteral,
} from "../src/services/embeddingService.js";

// Backfill kolom embedding — jalankan setelah `npm run seed`, atau kapan pun ada
// baris yang embeddingnya bolong (misalnya OpenRouter sempat down saat produk
// dibuat lewat API).
//
//   npm run embed            -> hanya baris yang embeddingnya masih NULL (idempotent,
//                               aman dijalankan berulang — tidak ada API call ulang
//                               untuk baris yang sudah terisi)
//   npm run embed -- --all   -> paksa embed ulang SEMUA baris. Wajib setelah ganti
//                               model embedding atau mengubah productEmbeddingText().
//
// Batch 50 teks per request — endpoint menerima array, jadi 60 produk = 2 request,
// bukan 60.
const BATCH_SIZE = 50;

async function main() {
  const all = process.argv.includes("--all");

  await sequelize.authenticate();

  const rows = await sequelize.query(
    `SELECT id, name, brand, category FROM products
     ${all ? "" : "WHERE embedding IS NULL"}
     ORDER BY id`,
    { type: QueryTypes.SELECT }
  );

  if (rows.length === 0) {
    console.log("✅ Tidak ada yang perlu di-embed (semua baris sudah terisi).");
    console.log("   Pakai `npm run embed -- --all` untuk memaksa embed ulang semuanya.");
    process.exit(0);
  }

  console.log(`Meng-embed ${rows.length} produk${all ? " (--all, semua baris)" : ""}...`);

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const vectors = await embedTexts(batch.map(productEmbeddingText));

    for (let j = 0; j < batch.length; j++) {
      await sequelize.query(
        "UPDATE products SET embedding = :vec::vector WHERE id = :id",
        { replacements: { vec: toVectorLiteral(vectors[j]), id: batch[j].id } }
      );
    }

    done += batch.length;
    console.log(`  ${done}/${rows.length}`);
  }

  console.log(`✅ Selesai — ${done} produk ter-embed.`);
  process.exit(0);
}

main().catch((err) => {
  // Sengaja tidak ditelan: backfill setengah jadi lebih baik terlihat gagal
  // daripada diam. Baris yang belum sempat terisi tetap NULL — jalankan ulang
  // `npm run embed` untuk melanjutkan dari sisa yang bolong.
  console.error("❌ Backfill embedding gagal:", err.message);
  process.exit(1);
});
