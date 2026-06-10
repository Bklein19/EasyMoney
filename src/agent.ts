import { Agent, tool, run, RunItemStreamEvent } from "@openai/agents";
import { readFile } from "fs/promises";
import { validate } from "./validate";
import { listParserIds, getParser, upsertParser, executeParser } from "./parserStore";
import { listAccountsWithAliases, lookupAlias, createAccount, createAlias } from "./accounts";
import type { ParseResult } from "./types";
import { z } from "zod";

const SYSTEM_PROMPT = `You are a financial data parser agent. You communicate ONLY through tool calls — never respond with plain text.

Every turn you must call exactly one tool. Keep calling tools until finish() succeeds.

## Required sequence

1. Call read_pdf_text (for .pdf) or read_file_sample (for everything else) to read the file
2. Call list_parsers to see what already exists
3. If a matching parser exists, call run_parser with it
   - If run_parser returns ok:true → proceed to account mapping (step 4)
   - If run_parser returns ok:false → call write_parser with a fixed version, then run_parser again
4. If no matching parser exists, call write_parser with a new parser, then IMMEDIATELY call run_parser
   - If run_parser returns ok:true → proceed to account mapping
   - If run_parser returns ok:false → call write_parser with a fixed version, then run_parser again
5. Repeat write_parser → run_parser until ok:true
6. Call list_accounts to see existing canonical accounts
7. For each (institution, account) pair in the parse result, check if it already has an alias mapped.
   - finish() will tell you which pairs are unmapped — call finish() to see the list, then map them
   - If an existing account clearly matches (same institution + recognizable name/number), call map_account to add the alias
   - If no existing account matches, call create_account with appropriate type, classification, and tax_treatment, then call map_account
8. Once all accounts are mapped, call finish() — it will succeed when everything is mapped

## CRITICAL RULES
- You MUST call run_parser after every write_parser — never call finish() without a successful run_parser first
- You MUST call finish() to complete the job — never stop without calling finish()
- Never call finish() unless the most recent run_parser returned ok:true

## Account classification guide

type: checking | savings | brokerage | retirement | credit-card | loan | unknown
classification: asset (money you own) | liability (money you owe)
tax_treatment: taxable | traditional (pre-tax 401k/IRA) | roth | hsa | none (checking/savings/loans)

Examples:
- Vanguard brokerage account → type:brokerage, classification:asset, tax_treatment:taxable
- Vanguard 401(k) → type:retirement, classification:asset, tax_treatment:traditional
- Roth IRA → type:retirement, classification:asset, tax_treatment:roth
- Chase checking → type:checking, classification:asset, tax_treatment:none
- Credit card → type:credit-card, classification:liability, tax_treatment:none

## Parser requirements

parser_id format: <institution>-<file-type>  (e.g. chase-checking-csv, fidelity-activity-pdf)
write_parser also requires institution (e.g. "Chase") and file_type (e.g. "checking-csv") as separate fields.

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
      const result = listParserIds();
      emit({ type: "tool_result", tool: "list_parsers", result });
      return result;
    },
  });

  const readParser = tool({
    name: "read_parser",
    description: "Read the source code of an existing parser.",
    parameters: z.object({
      parser_id: z.string().describe("Parser id"),
    }),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "read_parser", args });
      const parser = getParser(args.parser_id);
      if (!parser) throw new Error(`Parser not found: ${args.parser_id}`);
      emit({ type: "tool_result", tool: "read_parser", result: parser.code });
      return parser.code;
    },
  });

  const writeParser = tool({
    name: "write_parser",
    description: "Write or overwrite a parser in the database.",
    parameters: z.object({
      parser_id: z.string().describe("Parser id in the form <institution>-<file-type>"),
      institution: z.string().describe("Institution name, e.g. Vanguard, Chase"),
      file_type: z.string().describe("File type, e.g. activity-pdf, checking-csv"),
      code: z.string().describe("Complete TypeScript source for the parser"),
    }),
    execute: async (args) => {
      const { parser_id, institution, file_type, code } = args;
      emit({ type: "tool_call", tool: "write_parser", args: { parser_id, institution, file_type } }); // omit code from display
      upsertParser({ id: parser_id, institution, file_type, code });
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
      let parseResult: ParseResult;
      try {
        parseResult = await executeParser(parser_id, filePath);
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

  const listAccounts = tool({
    name: "list_accounts",
    description: "List all canonical accounts with their existing alias strings.",
    parameters: z.object({}),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "list_accounts", args });
      const result = listAccountsWithAliases();
      emit({ type: "tool_result", tool: "list_accounts", result });
      return result;
    },
  });

  const createAccountTool = tool({
    name: "create_account",
    description: "Create a new canonical account. Returns the new account id.",
    parameters: z.object({
      name: z.string().describe("Human-readable account name, e.g. 'Brokerage - 34702059'"),
      institution: z.string().describe("Institution name, e.g. 'Vanguard'"),
      type: z.enum(["checking", "savings", "brokerage", "retirement", "credit-card", "loan", "unknown"]),
      classification: z.enum(["asset", "liability"]),
      tax_treatment: z.enum(["taxable", "traditional", "roth", "hsa", "none"]),
    }),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "create_account", args });
      const id = createAccount(args);
      const result = { ok: true, account_id: id };
      emit({ type: "tool_result", tool: "create_account", result });
      return result;
    },
  });

  const mapAccount = tool({
    name: "map_account",
    description: "Map a parser-emitted (institution, account string) pair to a canonical account id.",
    parameters: z.object({
      institution: z.string().describe("Institution as emitted by the parser"),
      alias: z.string().describe("Account string as emitted by the parser"),
      account_id: z.number().describe("Canonical account id to map to"),
    }),
    execute: async (args) => {
      emit({ type: "tool_call", tool: "map_account", args });
      createAlias(args.institution, args.alias, args.account_id);
      const result = { ok: true };
      emit({ type: "tool_result", tool: "map_account", result });
      return result;
    },
  });

  const finish = tool({
    name: "finish",
    description: "Signal that parsing and account mapping are complete. Returns ok:true when all accounts are mapped, or lists unmapped pairs so you can map them.",
    parameters: z.object({
      parser_id: z.string().describe("The validated parser id"),
    }),
    execute: async (args) => {
      const { parser_id } = args;
      emit({ type: "tool_call", tool: "finish", args });
      if (!lastValidResult) {
        const result = { ok: false, error: "You must call run_parser successfully before calling finish(). Call write_parser then run_parser first." };
        emit({ type: "tool_result", tool: "finish", result });
        return result;
      }

      // Collect all (institution, account) pairs from the parse result
      const pairs = new Map<string, { institution: string; account: string }>();
      for (const t of lastValidResult.parseResult.transactions) {
        pairs.set(`${t.institution}\0${t.account}`, { institution: t.institution, account: t.account });
      }
      for (const b of lastValidResult.parseResult.balances) {
        pairs.set(`${b.institution}\0${b.account}`, { institution: b.institution, account: b.account });
      }

      const unmapped: Array<{ institution: string; account: string }> = [];
      for (const { institution, account } of pairs.values()) {
        if (lookupAlias(institution, account) === null) {
          unmapped.push({ institution, account });
        }
      }

      if (unmapped.length > 0) {
        const result = {
          ok: false,
          error: `${unmapped.length} account(s) not yet mapped. Call list_accounts, then map_account (or create_account + map_account) for each.`,
          unmapped,
        };
        emit({ type: "tool_result", tool: "finish", result });
        return result;
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
    tools: [readFileSample, readPdfText, listParsers, readParser, writeParser, runParser, listAccounts, createAccountTool, mapAccount, finish],
    toolUseBehavior: (_ctx, toolResults) => {
      for (const r of toolResults) {
        if (r.type === "function_output" && r.tool.name === "finish") {
          try {
            const output = JSON.parse(r.output as string) as { ok: boolean };
            if (output.ok) return { isFinalOutput: true, isInterrupted: undefined, finalOutput: r.output as string };
          } catch {}
        }
      }
      return { isFinalOutput: false, isInterrupted: undefined };
    },
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
