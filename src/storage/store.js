const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "results.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveEntries(newEntries) {
  ensureDataDir();
  // Overwrite instead of appending - each new scrape starts with a clean
  // slate, so results from a previous website/run never mix with the
  // current one.
  fs.writeFileSync(DATA_FILE, JSON.stringify(newEntries, null, 2), "utf-8");
  return newEntries;
}

function clearAll() {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), "utf-8");
}

async function exportToExcel(entries, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Extracted Data");

  sheet.columns = [
    { header: "Owner Name(s)", key: "ownerNames", width: 35 },
    { header: "Business Name", key: "businessName", width: 25 },
    { header: "City", key: "city", width: 18 },
    { header: "Published Date", key: "publishDate", width: 15 },
    { header: "Source URL", key: "sourceUrl", width: 50 },
  ];

  entries.forEach((entry) => {
    // Partnership case: there can be 2+ owners, shown comma-separated.
    // Backward-compat: older entries might have a single "ownerName" field.
    const ownerNamesList = Array.isArray(entry.ownerNames)
      ? entry.ownerNames
      : entry.ownerName
      ? [entry.ownerName]
      : [];

    sheet.addRow({
      ownerNames: ownerNamesList.join(", "),
      businessName: entry.businessName,
      city: entry.city,
      publishDate: entry.publishDate || "",
      sourceUrl: entry.sourceUrl,
    });
  });
  sheet.getRow(1).font = { bold: true };

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { loadAll, saveEntries, clearAll, exportToExcel, DATA_FILE };
