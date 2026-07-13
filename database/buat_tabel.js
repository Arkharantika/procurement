// Schema applier sekali-jalan: baca buat_tabel.sql, kirim ke Postgres, selesai.
// Sengaja pakai klien pg mentah, bukan koneksi Sequelize di koneksi_database.js —
// karena tugasnya menyiapkan tabel yang justru belum ada saat ini dijalankan.
import "../src/loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const sqlPath = path.join(__dirname, "buat_tabel.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");

  await client.query(sql);
  console.log("✅ Schema applied successfully (products table + pg_trgm index)");

  await client.end();
}

run().catch((err) => {
  console.error("❌ Failed to apply schema:", err.message);
  process.exit(1);
});
