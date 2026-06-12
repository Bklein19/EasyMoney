// Parser registry: the single source of truth for which committed parser handles
// which file. This replaces the old mutable `parsers` DB table.
import type { ParserModule, ParseResult } from "../src/types";

import { meta as msStmtMeta, default as msStmtParse } from "./morgan-stanley-pdf";
import { meta as msActMeta, default as msActParse } from "./morgan-stanley-activity-pdf";
import { meta as vgStmtMeta, default as vgStmtParse } from "./vanguard-statement-pdf";
import { meta as vgActMeta, default as vgActParse } from "./vanguard-activity-pdf";
import { meta as fidInvMeta, default as fidInvParse } from "./fidelity-investment-report-pdf";
import { meta as fid401kMeta, default as fid401kParse } from "./fidelity-401k-html";
import { meta as seqMeta, default as seqParse } from "./sequoia-fund-pdf";
import { meta as merrillActMeta, default as merrillActParse } from "./merrill-activity-csv";

export const PARSERS: ParserModule[] = [
  { meta: msStmtMeta, parse: msStmtParse },
  { meta: msActMeta, parse: msActParse },
  { meta: vgStmtMeta, parse: vgStmtParse },
  { meta: vgActMeta, parse: vgActParse },
  { meta: fidInvMeta, parse: fidInvParse },
  { meta: fid401kMeta, parse: fid401kParse },
  { meta: seqMeta, parse: seqParse },
  { meta: merrillActMeta, parse: merrillActParse },
];

export function getParserById(id: string): ParserModule | undefined {
  return PARSERS.find((p) => p.meta.id === id);
}

// Reads a short text sample for content-based disambiguation, then returns the
// single matching parser. Throws if zero or multiple parsers match — matchers must
// be mutually exclusive for the rebuild to be deterministic.
export async function resolveParser(filePath: string): Promise<ParserModule> {
  // Raw files are stored as "<sha256>-<original-filename>"; matchers expect the
  // original filename, so strip a leading 64-hex-char content-hash prefix if present.
  const stored = filePath.split("/").pop() ?? filePath;
  const filename = stored.replace(/^[0-9a-f]{64}-/, "");

  // Content sample for disambiguating generically-named files. Only computed when
  // the filename alone isn't decisive — extracting PDF text is comparatively costly.
  let sample = "";
  const filenameDecisive = PARSERS.filter((p) => p.meta.matches({ filename, sample: "" })).length === 1;
  if (!filenameDecisive) {
    try {
      if (filename.endsWith(".pdf")) {
        const { getDocumentProxy, extractText } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
        const { text } = await extractText(pdf);
        sample = text.join("\n").slice(0, 4096);
      } else {
        sample = (await Bun.file(filePath).text()).slice(0, 4096);
      }
    } catch {}
  }

  const hits = PARSERS.filter((p) => p.meta.matches({ filename, sample }));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new Error(`No parser matches file: ${filename}`);
  throw new Error(`Multiple parsers match ${filename}: ${hits.map((h) => h.meta.id).join(", ")}`);
}

export function executeParser(parserId: string, filePath: string): Promise<ParseResult> {
  const p = getParserById(parserId);
  if (!p) throw new Error(`Parser not found: ${parserId}`);
  return p.parse(filePath);
}
