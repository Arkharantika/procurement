import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Muat .env dari ROOT PROYEK (satu level di atas src/), bukan dari direktori kerja.
//
// `import "dotenv/config"` mencari .env relatif terhadap process.cwd(), jadi
// `cd scripts && node init-db.js` akan mencari scripts\.env dan gagal menemukannya.
// Dengan resolve dari lokasi file ini, semua entry point jalan dari mana pun dipanggil.
dotenv.config({ path: path.join(__dirname, "..", ".env") });
