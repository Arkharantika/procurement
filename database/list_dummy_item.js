import "../src/loadEnv.js";
import { sequelize } from "./koneksi_database.js";
import { Product } from "../src/Product.js";

// Data contoh lintas bidang, untuk membuktikan modul ini generic (bukan cuma elektrikal).
//
// PENTING — data ini sengaja disusun BERKLASTER: tiap jenis item punya 2-4 varian yang
// beda tipis (beda ampere, beda ukuran, beda gramatur, beda kapasitas). Itu bukan
// kebetulan. Katalog yang tiap barisnya unik tidak akan pernah memicu jalur "ambigu"
// maupun LLM rerank — semuanya lolos lewat jalur pintas auto-match, dan kita jadi tidak
// pernah benar-benar menguji bagian tersulit dari modul ini.
//
// Klaster di bawah membuat trigram mengembalikan beberapa kandidat berskor nyaris sama,
// sehingga keputusan benar/salah jatuh ke LLM (atau ke user) — persis yang mau dites.
const sampleProducts = [
  // === FOOTWEAR ===
  // Klaster sepatu: satu model, beda UKURAN. Ini jebakan paling jahat buat trigram —
  // "42" vs "43" cuma beda satu karakter, padahal barangnya jelas beda.
  { name: "Sepatu Nike Air Force 1 '07 Putih Size 41", brand: "Nike", category: "Footwear", price: 1499000, unit: "pasang" },
  { name: "Sepatu Nike Air Force 1 '07 Putih Size 42", brand: "Nike", category: "Footwear", price: 1499000, unit: "pasang" },
  { name: "Sepatu Nike Air Force 1 '07 Putih Size 43", brand: "Nike", category: "Footwear", price: 1499000, unit: "pasang" },
  { name: "Sepatu Nike Air Force 1 '07 Hitam Size 42", brand: "Nike", category: "Footwear", price: 1549000, unit: "pasang" },

  // Klaster Adidas: nama model berdekatan (Ultraboost 22 vs Ultraboost Light 23),
  // beda harga ratusan ribu.
  { name: "Sepatu Adidas Ultraboost 22 Hitam Size 42", brand: "Adidas", category: "Footwear", price: 2200000, unit: "pasang" },
  { name: "Sepatu Adidas Ultraboost Light 23 Hitam Size 42", brand: "Adidas", category: "Footwear", price: 2800000, unit: "pasang" },
  { name: "Sepatu Adidas Samba OG Putih Size 42", brand: "Adidas", category: "Footwear", price: 1750000, unit: "pasang" },

  // Klaster sepatu safety: relevan untuk pengadaan kantor/proyek.
  { name: "Sepatu Safety Krisbow Arrow 6 inch Size 42", brand: "Krisbow", category: "Footwear", price: 485000, unit: "pasang" },
  { name: "Sepatu Safety Krisbow Arrow 6 inch Size 43", brand: "Krisbow", category: "Footwear", price: 485000, unit: "pasang" },
  { name: "Sepatu Safety Cheetah 3108H Size 42", brand: "Cheetah", category: "Footwear", price: 395000, unit: "pasang" },

  // === WATCHES ===
  // Klaster G-Shock: kode model beda di SUFIKS saja (1A1 vs 1A4), warnanya beda.
  { name: "Jam Tangan Casio G-Shock GA-2100-1A1 Hitam", brand: "Casio", category: "Watches", price: 1850000, unit: "pcs" },
  { name: "Jam Tangan Casio G-Shock GA-2100-1A4 Merah", brand: "Casio", category: "Watches", price: 1850000, unit: "pcs" },
  { name: "Jam Tangan Casio G-Shock GA-2100SU-1A Hijau", brand: "Casio", category: "Watches", price: 2100000, unit: "pcs" },
  { name: "Jam Tangan Casio G-Shock DW-5600E-1V Hitam", brand: "Casio", category: "Watches", price: 1250000, unit: "pcs" },
  { name: "Jam Tangan Casio Vintage A158WA-1 Silver", brand: "Casio", category: "Watches", price: 425000, unit: "pcs" },

  // Klaster Seiko: satu seri, beda kode akhir & warna dial.
  { name: "Jam Tangan Seiko 5 Sports SRPD55K1 Hitam", brand: "Seiko", category: "Watches", price: 3450000, unit: "pcs" },
  { name: "Jam Tangan Seiko 5 Sports SRPD55K3 Biru", brand: "Seiko", category: "Watches", price: 3450000, unit: "pcs" },
  { name: "Jam Tangan Seiko Presage SRPB41J1 Putih", brand: "Seiko", category: "Watches", price: 6900000, unit: "pcs" },
  { name: "Jam Tangan Fossil Grant Chronograph FS4812", brand: "Fossil", category: "Watches", price: 2350000, unit: "pcs" },

  // === FURNITURE ===
  // Klaster meja: beda panjang. Query "meja kantor jati" harus memunculkan ketiganya.
  { name: "Meja Kantor Kayu Jati 120cm", brand: "Olympic", category: "Furniture", price: 850000, unit: "pcs" },
  { name: "Meja Kantor Kayu Jati 140cm", brand: "Olympic", category: "Furniture", price: 1050000, unit: "pcs" },
  { name: "Meja Kantor Kayu Jati 160cm", brand: "Olympic", category: "Furniture", price: 1280000, unit: "pcs" },
  { name: "Meja Rapat Oval 240cm Kayu Jati", brand: "Olympic", category: "Furniture", price: 3400000, unit: "pcs" },

  // Klaster kursi: beda tipe tapi nama sangat mirip.
  { name: "Kursi Kantor Ergonomis Jaring Hitam", brand: "Chairman", category: "Furniture", price: 650000, unit: "pcs" },
  { name: "Kursi Kantor Ergonomis Jaring Abu-abu", brand: "Chairman", category: "Furniture", price: 650000, unit: "pcs" },
  { name: "Kursi Kantor Direktur Kulit Hitam", brand: "Chairman", category: "Furniture", price: 1750000, unit: "pcs" },
  { name: "Kursi Staff Lipat Besi Hitam", brand: "Futura", category: "Furniture", price: 185000, unit: "pcs" },

  // Klaster lemari arsip.
  { name: "Lemari Arsip Besi 2 Pintu", brand: "Brother", category: "Furniture", price: 1200000, unit: "pcs" },
  { name: "Lemari Arsip Besi 4 Laci", brand: "Brother", category: "Furniture", price: 1650000, unit: "pcs" },
  { name: "Lemari Arsip Kayu 2 Pintu Sliding", brand: "Olympic", category: "Furniture", price: 980000, unit: "pcs" },

  // === ATK ===
  // Klaster kertas: beda ukuran (A4/F4) dan gramatur (70/80). Empat kombinasi,
  // nama nyaris sama persis — klaster paling ambigu di seluruh seed ini.
  { name: "Kertas HVS A4 70gr Sinar Dunia", brand: "Sinar Dunia", category: "ATK", price: 38000, unit: "rim" },
  { name: "Kertas HVS A4 80gr Sinar Dunia", brand: "Sinar Dunia", category: "ATK", price: 45000, unit: "rim" },
  { name: "Kertas HVS F4 70gr Sinar Dunia", brand: "Sinar Dunia", category: "ATK", price: 42000, unit: "rim" },
  { name: "Kertas HVS F4 80gr Sinar Dunia", brand: "Sinar Dunia", category: "ATK", price: 49000, unit: "rim" },
  { name: "Kertas HVS A4 80gr Paperone", brand: "Paperone", category: "ATK", price: 52000, unit: "rim" },

  // Klaster pulpen: beda warna tinta.
  { name: "Pulpen Standard AE7 Biru", brand: "Standard", category: "ATK", price: 3000, unit: "pcs" },
  { name: "Pulpen Standard AE7 Hitam", brand: "Standard", category: "ATK", price: 3000, unit: "pcs" },
  { name: "Pulpen Pilot G2 0.5 Biru", brand: "Pilot", category: "ATK", price: 12500, unit: "pcs" },

  // Klaster toner/tinta: kode tipe berdekatan.
  { name: "Toner Printer HP 85A Original", brand: "HP", category: "ATK", price: 750000, unit: "pcs" },
  { name: "Toner Printer HP 12A Original", brand: "HP", category: "ATK", price: 690000, unit: "pcs" },
  { name: "Toner Printer HP 85A Compatible", brand: "HP", category: "ATK", price: 185000, unit: "pcs" },
  { name: "Tinta Printer Epson 003 Black", brand: "Epson", category: "ATK", price: 85000, unit: "botol" },

  // === IT EQUIPMENT ===
  // Klaster laptop: beda prosesor & kapasitas — beda harga jutaan, jadi salah pilih mahal.
  { name: "Laptop Lenovo ThinkBook 14 G6 i5 16GB 512GB", brand: "Lenovo", category: "IT Equipment", price: 12500000, unit: "pcs" },
  { name: "Laptop Lenovo ThinkBook 14 G6 i7 16GB 512GB", brand: "Lenovo", category: "IT Equipment", price: 15900000, unit: "pcs" },
  { name: "Laptop Lenovo ThinkBook 14 G6 i5 8GB 256GB", brand: "Lenovo", category: "IT Equipment", price: 10200000, unit: "pcs" },
  { name: "Laptop Lenovo ThinkPad E14 Gen 5 i5 16GB 512GB", brand: "Lenovo", category: "IT Equipment", price: 14300000, unit: "pcs" },
  { name: "Laptop HP ProBook 440 G10 i5 16GB 512GB", brand: "HP", category: "IT Equipment", price: 13800000, unit: "pcs" },

  // Klaster mouse: satu brand, beberapa seri.
  { name: "Mouse Logitech M720 Triathlon Wireless", brand: "Logitech", category: "IT Equipment", price: 350000, unit: "pcs" },
  { name: "Mouse Logitech M170 Wireless", brand: "Logitech", category: "IT Equipment", price: 135000, unit: "pcs" },
  { name: "Mouse Logitech MX Master 3S Wireless", brand: "Logitech", category: "IT Equipment", price: 1450000, unit: "pcs" },

  { name: "Keyboard Logitech K380 Bluetooth", brand: "Logitech", category: "IT Equipment", price: 425000, unit: "pcs" },
  { name: "Keyboard Mechanical RGB Rexus Legionare", brand: "Rexus", category: "IT Equipment", price: 385000, unit: "pcs" },

  // === ELECTRONICS ===
  // Klaster TV: beda ukuran inch, nama nyaris identik.
  { name: "TV Samsung 50 inch Crystal UHD 4K", brand: "Samsung", category: "Electronics", price: 5400000, unit: "pcs" },
  { name: "TV Samsung 55 inch Crystal UHD 4K", brand: "Samsung", category: "Electronics", price: 6500000, unit: "pcs" },
  { name: "TV Samsung 65 inch Crystal UHD 4K", brand: "Samsung", category: "Electronics", price: 9200000, unit: "pcs" },
  { name: "TV LG 55 inch UHD 4K Smart TV", brand: "LG", category: "Electronics", price: 6150000, unit: "pcs" },

  // Klaster AC: beda PK.
  { name: "AC Daikin 1 PK Split Standard", brand: "Daikin", category: "Electronics", price: 4200000, unit: "unit" },
  { name: "AC Daikin 1.5 PK Split Standard", brand: "Daikin", category: "Electronics", price: 5350000, unit: "unit" },
  { name: "AC Daikin 2 PK Split Standard", brand: "Daikin", category: "Electronics", price: 7100000, unit: "unit" },
  { name: "AC Panasonic 1 PK Split Inverter", brand: "Panasonic", category: "Electronics", price: 4850000, unit: "unit" },
];

// Baris uji yang bagus untuk dicoba di UI setelah seed (paste apa adanya):
//
//   2 pasang Sepatu Nike Air Force 1 Putih   -> ambigu: size 41 / 42 / 43
//   1 pcs Casio G-Shock GA-2100              -> ambigu: 1A1 / 1A4 / SU-1A
//   5 pasang Sepatu Safety Krisbow 42        -> harusnya presisi walau tetangganya rapat
//   10 rim Kertas HVS A4 80gr                -> ambigu: Sinar Dunia vs Paperone
//   2 unit Meja Kantor Jati                  -> ambigu: 120 / 140 / 160cm
//   1 pcs Laptop Lenovo ThinkBook i5         -> ambigu: 16GB/512 vs 8GB/256
//   3 unit AC Daikin 1 PK                    -> "1 PK" vs "1.5 PK" — jebakan angka
//   1 pcs Jam Tangan Garmin Forerunner 265   -> tidak ada di DB, harusnya jatuh ke internet

async function seed() {
  await sequelize.authenticate();

  const existing = await Product.count();

  // Jangan diam-diam menggandakan atau menghapus data. Seed lama pakai bulkCreate
  // polos, jadi dijalankan dua kali = 2x data. Sekarang: kalau tabel sudah terisi,
  // berhenti dan minta konfirmasi eksplisit lewat flag --reset.
  if (existing > 0) {
    const reset = process.argv.includes("--reset");
    if (!reset) {
      console.error(
        `⚠️  Tabel products sudah berisi ${existing} baris. Seed dibatalkan.\n` +
          `   Jalankan dengan --reset untuk MENGHAPUS semuanya dan seed ulang:\n` +
          `     npm run seed -- --reset`
      );
      process.exit(1);
    }

    await Product.destroy({ where: {}, truncate: true, restartIdentity: true });
    console.log(`🗑️  ${existing} produk lama dihapus (--reset)`);
  }

  await Product.bulkCreate(sampleProducts);

  const categories = [...new Set(sampleProducts.map((p) => p.category))];
  console.log(
    `✅ Seeded ${sampleProducts.length} produk di ${categories.length} kategori: ${categories.join(", ")}`
  );
  console.log("   Data sengaja berklaster (varian mirip) supaya jalur ambigu & LLM rerank ikut teruji.");
  console.log("   ➡️  Lanjutkan dengan `npm run embed` untuk mengisi kolom embedding (pencarian vektor).");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
});
