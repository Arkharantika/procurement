import "../src/loadEnv.js";
import { Sequelize } from "sequelize";

// Koneksi Sequelize yang dipakai server sepanjang hidupnya (runtime).
// Jangan tertukar dengan buat_tabel.js — itu schema applier sekali-jalan.
export const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  logging: false,
});
