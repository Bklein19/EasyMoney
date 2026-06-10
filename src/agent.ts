import OpenAI from "openai";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const PARSERS_DIR = join(import.meta.dir, "../parsers");
const MAX_SAMPLE_BYTES = 4096;
const MAX_RETRIES = 3;

const client = new OpenAI();

export async function identifyAndGetParser(
  filePath: string,
  existingParserId?: string
): Promise<string> {
  const sample = await readSample(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "unknown";

  if (existingParserId) {
    const parserPath = join(PARSERS_DIR, `${existingParserId}.ts`);
    const existing = await readFile(parserPath, "utf8").catch(() => null);
    if (existing) return existing;
  }

  return writeParser(filePath, sample, ext, null, 0);
}

async function writeParser(
  filePath: string,
  sample: string,
  ext: string,
  previousErrors: string | null,
  attempt: number
): Promise<string> {
  if (attempt >= MAX_RETRIES) {
    throw new Error(`Parser agent failed after ${MAX_RETRIES} attempts`);
  }

  const prompt = buildPrompt(sample, ext, previousErrors);

  const response = await client.responses.create({
    model: "gpt-4o",
    input: prompt,
  });

  const raw = response.output_text;
  const code = extractCode(raw);
  const parserId = extractParserId(raw);

  const parserPath = join(PARSERS_DIR, `${parserId}.ts`);
  await writeFile(parserPath, code, "utf8");

  return parserId;
}

function buildPrompt(sample: string, ext: string, previousErrors: string | null): string {
  const errorSection = previousErrors
    ? `\n\nThe previous parser attempt failed validation with these errors:\n${previousErrors}\n\nFix the issues above.`
    : "";

  return `You are a financial data parser generator. Given a sample of a financial data file, write a TypeScript parser for Bun.

File extension: .${ext}
Sample (first ${MAX_SAMPLE_BYTES} bytes):
\`\`\`
${sample}
\`\`\`
${errorSection}

Write a TypeScript module that:
1. Exports a default async function parse(filePath: string): Promise<ParseResult>
2. Uses only Bun built-ins and stdlib (no npm imports except 'papaparse' for CSV or 'pdfjs-dist' for PDF if needed)
3. Returns this shape:
   interface ParseResult {
     transactions: Array<{
       id: string;          // deterministic hash of the row
       date: string;        // YYYY-MM-DD
       amount_cents: number; // integer, positive=credit negative=debit
       description: string;
       account: string;
       institution: string;
       raw: Record<string, unknown>;
     }>;
     balances: Array<{
       date: string;
       account: string;
       institution: string;
       balance_cents: number;
     }>;
   }

First, output a comment block at the top of the file with:
// PARSER_ID: <institution>-<file_type>  (e.g. chase-checking-csv)
// INSTITUTION: <name>
// FILE_TYPE: <type>

Then output the complete TypeScript code.
Only output code — no explanation outside the code block.`;
}

function extractCode(raw: string): string {
  const match = raw.match(/```(?:typescript|ts)?\n([\s\S]+?)```/);
  return match ? match[1]!.trim() : raw.trim();
}

function extractParserId(raw: string): string {
  const code = extractCode(raw);
  const match = code.match(/\/\/\s*PARSER_ID:\s*(.+)/);
  if (!match) throw new Error("Agent response missing // PARSER_ID: comment");
  return match[1]!.trim();
}

async function readSample(filePath: string): Promise<string> {
  const file = await readFile(filePath);
  const slice = file.slice(0, MAX_SAMPLE_BYTES);
  // Best-effort UTF-8 decode; PDFs will be binary garbage but that's fine for identification
  return slice.toString("utf8");
}

export async function retryWithErrors(
  filePath: string,
  parserId: string,
  validationErrors: string,
  attempt: number
): Promise<string> {
  const sample = await readSample(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "unknown";
  return writeParser(filePath, sample, ext, validationErrors, attempt);
}
