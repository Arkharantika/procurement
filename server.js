import "./src/loadEnv.js";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { sequelize } from "./database/koneksi_database.js";
import { registerSocketHandlers } from "./src/handlers.js";
import { productRoutes } from "./src/productRoutes.js";
import { parseFileToLines } from "./src/utils/fileParser.js";
import { buildQuotationXlsx } from "./src/utils/excelExport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Gagal cepat saat startup. Sebelumnya env yang kosong baru ketahuan saat baris
// pertama diproses — setelah user sudah upload file dan menunggu.
const REQUIRED_ENV = ["DATABASE_URL", "OPENROUTER_API_KEY", "SERPAPI_KEY"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Env belum lengkap: ${missing.join(", ")} (lihat .env.example)`);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// CRUD katalog produk (dipakai oleh public/products.html)
app.use("/api/products", productRoutes);

const upload = multer({ storage: multer.memoryStorage() });

// Upload Excel/CSV/TXT -> dikembalikan sebagai array baris teks.
// Client kemudian mengirim baris-baris ini lewat socket "start_price_finder".
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const lines = parseFileToLines(req.file.buffer, req.file.originalname);
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Unduh hasil sebagai Excel. Client mengirim balik array results yang ia terima dari
// event "done" — modul ini memang tidak menyimpan hasil proses ke database (keputusan
// desain: satu tabel products saja), jadi client-lah pemegang datanya.
app.post("/api/export", (req, res) => {
  try {
    const { results } = req.body || {};
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ message: "results[] kosong atau tidak valid" });
    }

    const buffer = buildQuotationXlsx(results);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="pricefinder-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

registerSocketHandlers(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`EstimaCore PriceFinder prototype running on http://localhost:${PORT}`);
});
