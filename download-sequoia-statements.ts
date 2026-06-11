// Downloads all Sequoia Fund quarterly statements from secureaccountview.com
// Run: bun download-sequoia-statements.ts

const SESSION = "OTExMGIyZTMtYmMwMC00ZWQ4LThhMTctZmEyMDgwYjE3Zjk2";
const CSRF = "9110b2e3-bc00-4ed8-8a17-fa2080b17f96";
const BASE_URL = "https://secureaccountview.com/BFWeb/clients/sequoiafund";
const OUT_DIR = "./imports/statements";

import { mkdir, exists } from "fs/promises";

// Step 1: fetch the statement list (also gives us a fresh sessionId)
const listResp = await fetch(
  `${BASE_URL}/statements/getStatementList?queryType=all`,
  {
    headers: {
      Accept: "application/json",
      Cookie: `SESSION=${SESSION}`,
      Referer: `${BASE_URL}/viewStatements`,
    },
  }
);
const list = (await listResp.json()) as {
  success: boolean;
  data: {
    sessionId: string;
    statements: Array<{
      documentId: string;
      statementType: string;
      statementDate: string;
      statementDescription: string;
    }>;
  };
};

if (!list.success) {
  console.error("Failed to fetch statement list:", list);
  process.exit(1);
}

const { sessionId, statements } = list.data;
console.log(`Found ${statements.length} statements, sessionId: ${sessionId.slice(0, 20)}...`);

await mkdir(OUT_DIR, { recursive: true });

let ok = 0, skip = 0, fail = 0;

for (const stmt of statements) {
  const filename = `sequoia-fund-${stmt.statementDate}.pdf`;
  const outPath = `${OUT_DIR}/${filename}`;

  if (await exists(outPath)) {
    const size = Bun.file(outPath).size;
    if (size > 1000) {
      console.log(`  skip (exists, ${size}b): ${filename}`);
      skip++;
      continue;
    }
  }

  const url = `${BASE_URL}/statements/${stmt.documentId}/${stmt.statementType}/${sessionId}?csrf_token=${CSRF}`;
  const resp = await fetch(url, {
    headers: {
      Cookie: `SESSION=${SESSION}`,
      Referer: `${BASE_URL}/viewStatements`,
    },
  });

  if (!resp.ok) {
    console.error(`  ERROR ${resp.status} for ${filename}`);
    fail++;
    continue;
  }

  const buf = await resp.arrayBuffer();
  await Bun.write(outPath, buf);
  console.log(`  saved (${buf.byteLength}b): ${filename}`);
  ok++;
}

console.log(`\nDone: ${ok} saved, ${skip} skipped, ${fail} failed`);
