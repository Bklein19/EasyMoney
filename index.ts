import { importFile } from "./src/importer";

const [, , filePath] = process.argv;

if (!filePath) {
  console.error("Usage: bun run index.ts <path-to-file>");
  process.exit(1);
}

try {
  const report = await importFile(filePath);
  console.log(`Imported successfully:`);
  console.log(`  File ID:       ${report.fileId}`);
  console.log(`  Parser:        ${report.parserId}`);
  console.log(`  Transactions:  ${report.transactionsInserted}`);
  console.log(`  Balances:      ${report.balancesInserted}`);
} catch (err) {
  console.error("Import failed:", err);
  process.exit(1);
}
