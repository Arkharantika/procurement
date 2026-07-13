import { Router } from "express";
import { Op } from "sequelize";
import { Product } from "./Product.js";

export const productRoutes = Router();

const MAX_LIMIT = 100;

// Bentuk yang dikirim ke client. pg mengembalikan BIGINT dan NUMERIC sebagai string;
// dinormalkan di sini supaya UI tidak perlu tahu soal itu (dan supaya angka tidak
// diam-diam jadi teks saat dihitung di browser).
function toJson(p) {
  return {
    id: String(p.id),
    name: p.name,
    brand: p.brand,
    category: p.category,
    price: p.price === null ? null : Number(p.price),
    unit: p.unit,
    created_at: p.created_at,
  };
}

// Validasi terpusat — dipakai oleh create maupun update, supaya aturannya tidak
// menyimpang antara keduanya. Mengembalikan { data } atau { error }.
function validate(body, { partial = false } = {}) {
  const out = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return { error: "Nama produk wajib diisi" };
    out.name = name;
  } else if (!partial) {
    return { error: "Nama produk wajib diisi" };
  }

  for (const field of ["brand", "category", "unit"]) {
    if (body[field] !== undefined) {
      const v = String(body[field]).trim();
      out[field] = v === "" ? null : v;
    }
  }

  if (body.price !== undefined) {
    if (body.price === null || body.price === "") {
      out.price = null;
    } else {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) {
        return { error: "Harga harus angka >= 0" };
      }
      out.price = price;
    }
  }

  if (Object.keys(out).length === 0) return { error: "Tidak ada field yang diubah" };
  return { data: out };
}

// LIST — mendukung pencarian & paginasi.
// Pencarian di sini sengaja pakai ILIKE, BUKAN trigram seperti searchService.js:
// ini layar admin, di mana user mengetik potongan nama yang dia INGAT dan ingin
// hasil yang persis mengandung teks itu. Trigram justru akan memunculkan barang
// mirip yang tidak dia cari.
productRoutes.get("/", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit) || 25, MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = q
      ? {
          [Op.or]: [
            { name: { [Op.iLike]: `%${q}%` } },
            { brand: { [Op.iLike]: `%${q}%` } },
            { category: { [Op.iLike]: `%${q}%` } },
          ],
        }
      : undefined;

    const { rows, count } = await Product.findAndCountAll({
      where,
      order: [["id", "ASC"]], // urut naik — nomor 1 di atas, seperti daftar pada umumnya
      limit,
      offset,
    });

    res.json({ items: rows.map(toJson), total: count, limit, offset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// CREATE
productRoutes.post("/", async (req, res) => {
  try {
    const { data, error } = validate(req.body || {});
    if (error) return res.status(400).json({ message: error });

    const product = await Product.create(data);
    res.status(201).json(toJson(product));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// UPDATE — partial: field yang tidak dikirim tidak diubah.
productRoutes.put("/:id", async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ message: "Produk tidak ditemukan" });

    const { data, error } = validate(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ message: error });

    await product.update(data);
    res.json(toJson(product));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE — mengembalikan produk yang dihapus, supaya UI bisa menampilkan
// "X dihapus" dengan nama yang benar tanpa menebak dari state lokalnya.
productRoutes.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ message: "Produk tidak ditemukan" });

    const salinan = toJson(product);
    await product.destroy();
    res.json({ deleted: salinan });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
