import * as XLSX from "xlsx";

// Mengubah file upload (Excel/CSV/TXT) menjadi array baris teks mentah.
// Untuk Excel: setiap baris digabung dari semua kolom yang terisi (kita
// tidak berasumsi soal struktur kolom, karena datanya bisa dari bidang apa saja).
export function parseFileToLines(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (ext === "txt" || ext === "csv") {
    const text = buffer.toString("utf-8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // xlsx / xls
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  return rows
    .map((row) =>
      row
        .filter((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")
        .join(" ")
        .trim()
    )
    .filter(Boolean);
}
