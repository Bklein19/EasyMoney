import docs from "/tmp/ms-docs-list.json";
import { mkdir, exists } from "node:fs/promises";

const OUT_DIR = "/Users/example-user/src/money/imports/statements";

// These come from the browser session - we'll pass them in via env or capture fresh
// Run: bun download-ms-statements.ts TOKEN XSRF
const TOKEN = process.argv[2];
const XSRF = process.argv[3];

if (!TOKEN || !XSRF) {
  console.error("Usage: bun download-ms-statements.ts <bearer_token> <xsrf_token>");
  process.exit(1);
}

const AUTH_TOKEN = TOKEN;
const XSRF_TOKEN = XSRF;

const DEVICE_FP =
  "version=3.5.1_4&pm_fpua=mozilla/5.0 (macintosh; intel mac os x 10_15_7) applewebkit/537.36 (khtml, like gecko) chrome/149.0.0.0 safari/537.36|5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36|MacIntel&pm_fpsc=30|1470|956|923&pm_fptz=-8&pm_fpln=lang=en-US|syslang=|userlang=&pm_fpjv=0&pm_fpco=1&pm_fpan=Netscape&pm_fpacn=Mozilla&pm_fpol=true&pm_fpsaw=1470&pm_fpspd=30&pm_br=Chrome";

function docFilename(doc: { date: string; title: string; account: string; docId: string }) {
  // e.g. morgan-stanley-0854-2019-06-30.pdf
  const accountSuffix = doc.account === "4958" ? "0854" : doc.account === "2977" ? "7571" : doc.account;
  const titleSlug = doc.title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `morgan-stanley-${accountSuffix}-${doc.date}-${titleSlug}.pdf`;
}

async function downloadDoc(doc: (typeof docs)[0]) {
  const filename = docFilename(doc);
  const outPath = `${OUT_DIR}/${filename}`;

  if (await exists(outPath)) {
    const size = (await Bun.file(outPath).size);
    if (size > 1000) {
      console.log(`  skip (exists, ${size}b): ${filename}`);
      return true;
    }
  }

  const url = `https://mso.morganstanleyclientserv.com/msoaz/api/acdsal/accountdocs/document/${encodeURIComponent(doc.docId)}?RequestID=dl-${Date.now()}&SeqID=0001`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-XSRF-TOKEN": XSRF_TOKEN,
      "x-device-footprint": DEVICE_FP,
      "Content-Type": "application/json",
      accept: "application/json",
      referer: "https://mso.morganstanleyclientserv.com/atrium/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({}),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`  ERROR ${resp.status} for ${filename}: ${body.slice(0, 200)}`);
    return false;
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("pdf") && !contentType.includes("octet")) {
    const body = await resp.text();
    console.error(`  WRONG content-type ${contentType} for ${filename}: ${body.slice(0, 200)}`);
    return false;
  }

  const buf = await resp.arrayBuffer();
  await Bun.write(outPath, buf);
  console.log(`  saved (${buf.byteLength}b): ${filename}`);
  return true;
}

await mkdir(OUT_DIR, { recursive: true });

let ok = 0, fail = 0;
for (let i = 0; i < docs.length; i++) {
  const doc = docs[i];
  if (!doc) continue;
  console.log(`[${i + 1}/${docs.length}] ${doc.date} ${doc.title} (acct ...${doc.account})`);
  const success = await downloadDoc(doc);
  if (success) ok++; else fail++;
  // Small delay to avoid rate limiting
  if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
}

console.log(`\nDone: ${ok} ok, ${fail} failed`);
