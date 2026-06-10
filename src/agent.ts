import { Agent, tool, run } from "@openai/agents";
import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { validate } from "./validate";
import type { ParseResult } from "./types";
import { z } from "zod";

const PARSERS_DIR = join(import.meta.dir, "../parsers");

const SYSTEM_PROMPT = `You are a financial data parser agent. Your job is to produce a working TypeScript parser for a given financial data file and confirm it imports correctly.

Workflow:
1. Read a sample of the file to identify the institution and format
   - For PDFs, use read_pdf_text instead of read_file_sample
2. Check if a matching parser already exists with list_parsers / read_parser
3. If yes, run it — if validation passes, call finish()
4. If no match (or validation fails), write a new or fixed parser, then run and validate again
5. Iterate until validation passes, then call finish()

Parser file requirements:
- parser_id format: <institution>-<file-type>  (e.g. chase-checking-csv, fidelity-brokerage-pdf)
- Must export a default async function: export default async function parse(filePath: string): Promise<ParseResult>
- Use only Bun built-ins — no npm imports except 'papaparse' for CSV or 'pdfjs-dist' for PDF
- ParseResult shape:
  {
    transactions: Array<{
      id: string;           // deterministic SHA-256 hash of the row
      date: string;         // YYYY-MM-DD
      amount_cents: number; // integer; positive=credit, negative=debit
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
  }`;

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "message";
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}

export interface AgentResult {
  parserId: string;
  parseResult: ParseResult;
}

export async function runIngestionAgent(
  filePath: string,
  onEvent?: (event: AgentEvent) => void
): Promise<AgentResult> {
  let lastValidResult: AgentResult | null = null;

  function emit(event: AgentEvent) {
    onEvent?.(event);
  }

  const readFileSample = tool({
    name: "read_file_sample",
    description: "Read raw bytes (as UTF-8 text) from the import file. For PDFs use read_pdf_text instead.",
    parameters: z.object({
      offset: z.number().optional().describe("Byte offset to start reading from (default 0)"),
      length: z.number().optional().describe("Number of bytes to read (default 4096, max 16384)"),
    }),
    execute: async (args) => {
      const { offset = 0, length = 4096 } = args;
      emit({ type: "tool_call", tool: "read_file_sample", args });
      const buf = await readFile(filePath);
      const result = buf.slice(offset, Math.min(offset + length, offset + 16384)).toString("utf8");
      emit({ type: "tool_result", tool: "read_file_sample", result });
      return result;
    },
  });

  const readPdfText = tool({
    name: "read_pdf_text",
    description: "Extract text from a PDF file page by page. Use this instead of read_file_sample for .pdf files.",
    parameters: z.object({
      start_page: z.number().optional().describe("First page to extract (1-indexed, default 1)"),
      end_page: z.number().optional().describe("Last page to extract (default: first 5 pages)"),
    }),
    execute: async (args) => {
      const { start_page = 1, end_page } = args;
      emit({ type: "tool_call", tool: "read_pdf_text", args });
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const data = await readFile(filePath);
      const pdf = await getDocument({ data }).promise;
      const totalPages = pdf.numPages;
      const last = Math.min(end_page ?? Math.min(start_page + 4, totalPages), totalPages);
      const pages: string[] = [];
      for (let i = start_page; i <= last; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        pages.push(`--- Page ${i} ---\n${text}`);
      }
      const result = { total_pages: totalPages, pages };
      emit({ type: "tool_result", tool: "read_pdf_text", result });
      return result;
    },
  });

  const listParsers = tool({
    name: "list_parsers",
    description: "List all existing parser IDs.",
    parameters: z.object({}),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "list_parsers", args });
      const files = await readdir(PARSERS_DIR);
      const result = files
        .filter((f) => f.endsWith(".ts") && f !== ".gitkeep")
        .map((f) => f.replace(/\.ts$/, ""));
      emit({ type: "tool_result", tool: "list_parsers", result });
      return result;
    },
  });

  const readParser = tool({
    name: "read_parser",
    description: "Read the source code of an existing parser.",
    parameters: z.object({
      parser_id: z.string().describe("Parser id (filename without .ts)"),
    }),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "read_parser", args });
      const result = await readFile(join(PARSERS_DIR, `${args.parser_id}.ts`), "utf8");
      emit({ type: "tool_result", tool: "read_parser", result });
      return result;
    },
  });

  const writeParser = tool({
    name: "write_parser",
    description: "Write or overwrite a parser file.",
    parameters: z.object({
      parser_id: z.string().describe("Parser id (filename without .ts)"),
      code: z.string().describe("Complete TypeScript source for the parser"),
    }),
    execute: async (args) => {
      const { parser_id, code } = args;
      emit({ type: "tool_call", tool: "write_parser", args: { parser_id } }); // omit code from display
      await writeFile(join(PARSERS_DIR, `${parser_id}.ts`), code, "utf8");
      const result = { ok: true, parser_id };
      emit({ type: "tool_result", tool: "write_parser", result });
      return result;
    },
  });

  const runParser = tool({
    name: "run_parser",
    description: "Run a parser against the import file and return validation results.",
    parameters: z.object({
      parser_id: z.string().describe("Parser id to run"),
    }),
    execute: async (args) => {
      const { parser_id } = args;
      emit({ type: "tool_call", tool: "run_parser", args });
      const parserPath = join(PARSERS_DIR, `${parser_id}.ts`);
      let parseResult: ParseResult;
      try {
        const mod = await import(`${parserPath}?t=${Date.now()}`);
        parseResult = await (mod.default ?? mod.parse)(filePath);
      } catch (err) {
        const result = { ok: false, error: String(err), transaction_count: 0, balance_count: 0, errors: [] };
        emit({ type: "tool_result", tool: "run_parser", result });
        return result;
      }
      const validation = validate(parseResult);
      if (validation.ok) {
        lastValidResult = { parserId: parser_id, parseResult };
      }
      const result = {
        ok: validation.ok,
        transaction_count: parseResult.transactions.length,
        balance_count: parseResult.balances.length,
        errors: validation.errors.map((e) =>
          e.row != null ? `Row ${e.row} [${e.field}]: ${e.message}` : `[${e.field}]: ${e.message}`
        ),
      };
      emit({ type: "tool_result", tool: "run_parser", result });
      return result;
    },
  });

  const finish = tool({
    name: "finish",
    description: "Signal that the parser is working correctly and the import should proceed. Only call after run_parser returns ok: true.",
    parameters: z.object({
      parser_id: z.string().describe("The validated parser id"),
    }),
    execute: async (args) => {
      const { parser_id } = args;
      emit({ type: "tool_call", tool: "finish", args });
      if (!lastValidResult) {
        const result = { ok: false, error: "No validated parse result found. Run run_parser successfully first." };
        emit({ type: "tool_result", tool: "finish", result });
        return result;
      }
      lastValidResult = { ...lastValidResult, parserId: parser_id };
      const result = { ok: true };
      emit({ type: "tool_result", tool: "finish", result });
      return result;
    },
  });

  const agent = new Agent({
    name: "IngestionAgent",
    instructions: SYSTEM_PROMPT,
    model: "gpt-4o",
    tools: [readFileSample, readPdfText, listParsers, readParser, writeParser, runParser, finish],
  });

  await run(agent, `Import this file: ${filePath}`);

  if (!lastValidResult) {
    throw new Error("Ingestion agent completed without a validated parse result");
  }

  return lastValidResult;
}
