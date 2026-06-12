import { importFile } from "./importer";
import { getNetWorthReport } from "./networth";
import { getImportList } from "./imports";
import { getDb } from "./db";
import { updateAccount, deleteAlias } from "./accounts";
import type { AgentEvent } from "./agent";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import index from "../index.html";

const UPLOAD_TMP = join(import.meta.dir, "../imports/tmp");

function sseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function startServer(port = Number(process.env["PORT"] ?? 3000)) {
  return Bun.serve({
    port,
    idleTimeout: 0, // disable timeout — imports can take minutes
    routes: {
      "/": index,
      "/api/networth": {
        GET: () => Response.json(getNetWorthReport()),
      },
      "/api/imports": {
        GET: () => Response.json(getImportList()),
      },
      "/api/accounts": {
        GET: () => {
          const db = getDb();
          const accounts = db.query(`
            SELECT a.id, a.name, a.institution, a.type, a.classification, a.tax_treatment, a.flow_treatment,
              (SELECT balance_cents FROM (
                SELECT date, balance_cents FROM account_balances WHERE account_id = a.id
                UNION ALL
                SELECT date, balance_cents FROM manual_balances WHERE account_id = a.id
              ) ORDER BY date DESC LIMIT 1) as latest_balance_cents,
              (SELECT date FROM (
                SELECT date FROM account_balances WHERE account_id = a.id
                UNION ALL
                SELECT date FROM manual_balances WHERE account_id = a.id
              ) ORDER BY date DESC LIMIT 1) as latest_balance_date
            FROM accounts a
            ORDER BY a.institution, a.name
          `).all();
          const manualBalances = db.query(
            "SELECT id, account_id, date, balance_cents, note FROM manual_balances ORDER BY account_id, date DESC"
          ).all();
          const aliases = db.query(
            "SELECT account_id, institution, alias FROM account_aliases ORDER BY account_id, alias"
          ).all();
          return Response.json({ accounts, manualBalances, aliases });
        },
      },
      "/api/accounts/:id": {
        PATCH: async (req) => {
          const id = Number(req.params.id);
          if (!id) return Response.json({ error: "invalid account id" }, { status: 400 });
          updateAccount(id, await req.json());
          return Response.json({ ok: true });
        },
      },
      "/api/accounts/alias": {
        DELETE: async (req) => {
          const { institution, alias } = await req.json() as { institution: string; alias: string };
          deleteAlias(institution, alias);
          return Response.json({ ok: true });
        },
      },
      "/api/accounts/manual-balance": {
        POST: async (req) => {
          const { account_id, date, balance_cents, note } = await req.json() as {
            account_id: number; date: string; balance_cents: number; note?: string;
          };
          if (!account_id || !date || balance_cents === undefined) {
            return Response.json({ error: "account_id, date, and balance_cents required" }, { status: 400 });
          }
          const db = getDb();
          db.run(
            "INSERT OR REPLACE INTO manual_balances (account_id, date, balance_cents, note) VALUES (?, ?, ?, ?)",
            [account_id, date, balance_cents, note ?? null]
          );
          return Response.json({ ok: true });
        },
        DELETE: async (req) => {
          const { id } = await req.json() as { id: number };
          getDb().run("DELETE FROM manual_balances WHERE id = ?", [id]);
          return Response.json({ ok: true });
        },
      },
      "/api/import": {
        POST: async (req) => {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json({ error: "No file provided" }, { status: 400 });
          }

          await mkdir(UPLOAD_TMP, { recursive: true });
          const tmpPath = join(UPLOAD_TMP, file.name);
          await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));

          let controller: ReadableStreamDefaultController<string>;
          let closed = false;

          const stream = new ReadableStream<string>({
            start(c) { controller = c; },
          });

          const safeEnqueue = (msg: string) => {
            if (!closed) controller!.enqueue(msg);
          };

          const safeClose = () => {
            if (!closed) { closed = true; controller!.close(); }
          };

          const onEvent = (event: AgentEvent) => {
            safeEnqueue(sseMessage("agent_event", event));
          };

          importFile(tmpPath, onEvent)
            .then((report) => {
              safeEnqueue(sseMessage("done", report));
              safeClose();
            })
            .catch((err) => {
              safeEnqueue(sseMessage("error", { error: String(err) }));
              safeClose();
            });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        },
      },
    },
    development: { hmr: true, console: true },
  });
}
