import { Agent, tool, run, RunItemStreamEvent } from "@openai/agents";
import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { validate } from "./validate";
import type { ParseResult } from "./types";
import { z } from "zod";

const PARSERS_DIR = join(import.meta.dir, "../parsers");

const SYSTEM_PROMPT = `You are a financial data parser agent. You communicate ONLY through tool calls — never respond with plain text.

Every turn you must call exactly one tool. Keep calling tools until finish() succeeds.

## Required sequence

1. Call read_pdf_text (for .pdf) or read_file_sample (for everything else) to read the file
2. Call list_parsers to see what already exists
3. If a matching parser exists, call run_parser with it
   - If run_parser returns ok:true → call finish()
   - If run_parser returns ok:false → call write_parser with a fixed version, then run_parser again
4. If no matching parser exists, call write_parser with a new parser, then IMMEDIATELY call run_parser
   - If run_parser returns ok:true → call finish()
   - If run_parser returns ok:false → call write_parser with a fixed version, then run_parser again
5. Repeat write_parser → run_parser until ok:true, then call finish()

## CRITICAL RULES
- You MUST call run_parser after every write_parser — never call finish() without a successful run_parser first
- You MUST call finish() to complete the job — never stop without calling finish()
- Never call finish() unless the most recent run_parser returned ok:true

## Parser requirements

parser_id format: <institution>-<file-type>  (e.g. chase-checking-csv, fidelity-activity-pdf)

The parser file must:
- export default async function parse(filePath: string): Promise<ParseResult>
- import { createHash } from "crypto" for deterministic row IDs
- use Bun.file(filePath).text() to read files, or pdfjs-dist for PDFs
- only use npm packages: papaparse (CSV) or unpdf (PDF)
- for PDFs use this pattern exactly:
  import { getDocumentProxy, extractText } from "unpdf"
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()))
  const { totalPages, text: pageTexts } = await extractText(pdf)  // text is string[], one entry per page
  const pageText = pageTexts[0]  // page 1

ParseResult shape:
\`\`\`ts
interface ParseResult {
  transactions: Array<{
    id: string;           // createHash('sha256').update(JSON.stringify(rawRow)).digest('hex')
    date: string;         // YYYY-MM-DD
    amount_cents: number; // integer cents; positive=credit, negative=debit
    description: string;
    account: string;      // account name or number
    institution: string;  // e.g. "Fidelity", "Chase"
    raw: Record<string, unknown>;
  }>;
  balances: Array<{
    date: string;
    account: string;
    institution: string;
    balance_cents: number;
  }>;
}
\`\`\`

## When run_parser fails

Read the error carefully. Common fixes:
- Wrong date format → parse to YYYY-MM-DD
- amount_cents not integer → use Math.round(parseFloat(x) * 100)
- Missing required field → map from a different column
- Import error → check the import path and syntax
- Empty results → read more pages or adjust column parsing

After fixing, call write_parser with the corrected code, then call run_parser again.`;

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
    if (event.type === "tool_call") {
      const argStr = event.args ? JSON.stringify(event.args).slice(0, 120) : "";
      console.log(`[agent] → ${event.tool} ${argStr}`);
    } else if (event.type === "tool_result") {
      const resStr = JSON.stringify(event.result).slice(0, 120);
      console.log(`[agent] ← ${event.tool} ${resStr}`);
    }
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
      const { getDocumentProxy, extractText } = await import("unpdf");
      const data = await readFile(filePath);
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text: pageTexts } = await extractText(pdf);
      const last = Math.min(end_page ?? Math.min(start_page + 4, totalPages), totalPages);
      const pages: string[] = [];
      for (let i = start_page; i <= last; i++) {
        pages.push(`--- Page ${i} ---\n${(pageTexts as string[])[i - 1] ?? ""}`);
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
        throw new Error("You must call run_parser successfully before calling finish(). Call write_parser then run_parser first.");
      }
      lastValidResult = { ...lastValidResult, parserId: parser_id };
      const result = { ok: true, parser_id };
      emit({ type: "tool_result", tool: "finish", result });
      return result;
    },
  });

  const agent = new Agent({
    name: "IngestionAgent",
    instructions: SYSTEM_PROMPT,
    model: "gpt-5.4",
    tools: [readFileSample, readPdfText, listParsers, readParser, writeParser, runParser, finish],
    toolUseBehavior: { stopAtToolNames: ["finish"] },
  });

  const stream = await run(agent, `Import this file: ${filePath}`, { maxTurns: 128, stream: true });

  for await (const event of stream) {
    if (event instanceof RunItemStreamEvent && event.name === "message_output_created") {
      const item = event.item as { content?: Array<{ type: string; text?: string }> };
      const text = item.content
        ?.filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("")
        .trim();
      if (text) {
        console.log("[agent] message:", text);
        emit({ type: "message", text });
      }
    }
  }

  await stream.completed;

  if (!lastValidResult) {
    throw new Error("Ingestion agent completed without a validated parse result");
  }

  return lastValidResult;
}
