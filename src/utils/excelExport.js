import * as XLSX from "xlsx";

// Ubah hasil price finder jadi workbook Excel.
//
// Subtotal dihitung ULANG di sini dari qty x harga, tidak menerima nilai jadi dari
// client — supaya angka di file yang diunduh tidak mungkin berbeda dari angka yang
// bisa dipertanggungjawabkan. Baris tanpa harga (skipped/not_found/error) subtotalnya
// kosong, bukan 0, supaya tidak diam-diam ikut terhitung sebagai "gratis".
// Margin hanya berlaku untuk barang dari internet — harga internet adalah harga MODAL
// dari supplier, belum harga jual. Barang dari database sudah memuat harga jual kita
// sendiri, jadi menambahkan margin di atasnya berarti menghitung untung dua kali.
// Aturan ini HARUS sama persis dengan subtotalOf() di public/index.html; kalau tidak,
// angka di layar dan angka di file Excel akan berbeda.
function subtotalOf(r) {
  if (r.price === null || r.price === undefined) return null;
  const margin = r.source === "user_selected_internet" ? Number(r.margin) || 0 : 0;
  return (Number(r.qty) || 0) * Number(r.price) * (1 + margin / 100);
}

export function buildQuotationXlsx(results) {
  const header = [
    "No",
    "Item Asli",
    "Qty",
    "Unit",
    "Nama Terdeteksi",
    "Produk / Supplier",
    "Harga Satuan",
    "Margin %",
    "Subtotal",
    "Sumber",
    "URL",
  ];

  let total = 0;

  const rows = results.map((r, i) => {
    const qty = Number(r.qty) || 0;
    const harga = r.price === null || r.price === undefined ? null : Number(r.price);
    const internet = r.source === "user_selected_internet";
    const subtotal = subtotalOf(r);
    if (subtotal !== null) total += subtotal;

    return [
      i + 1,
      r.rawText ?? "",
      qty || "",
      r.unit ?? "",
      r.name ?? "",
      r.product?.name || r.product?.supplier || (r.error ? `ERROR: ${r.error}` : ""),
      harga,
      internet ? Number(r.margin) || 0 : "",
      subtotal,
      r.source ?? "",
      r.product?.url || "",
    ];
  });

  const aoa = [
    header,
    ...rows,
    [], // baris pemisah supaya TOTAL tidak menempel di data
    ["", "", "", "", "", "TOTAL", "", "", total, "", ""],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Format Rupiah untuk kolom G (harga satuan) dan I (subtotal), mulai baris 2.
  const fmt = '"Rp" #,##0';
  for (let r = 1; r < aoa.length; r++) {
    for (const col of ["G", "I"]) {
      const cell = sheet[`${col}${r + 1}`];
      if (cell && typeof cell.v === "number") cell.z = fmt;
    }
  }

  sheet["!cols"] = [
    { wch: 5 },
    { wch: 38 },
    { wch: 6 },
    { wch: 8 },
    { wch: 30 },
    { wch: 34 },
    { wch: 14 },
    { wch: 9 },
    { wch: 14 },
    { wch: 20 },
    { wch: 40 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Price Finder");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
