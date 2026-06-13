import { importFile, importFiles } from "./importer";
import { getNetWorthReport } from "./networth";
import { getSavingsRateReport } from "./savingsRate";
import { getTransferAuditReport } from "./transfers";
import { getImportList } from "./imports";
import { getDb } from "./db";
import { updateAccount, deleteAlias, createAlias } from "./accounts";
import { saveManualFacts } from "./manualFacts";
import { rebuild } from "./rebuild";
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
      "/api/savings-rate": {
        GET: () => Response.json(getSavingsRateReport()),
      },
      "/api/transfers": {
        GET: () => Response.json(getTransferAuditReport()),
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
          await saveManualFacts();
          return Response.json({ ok: true });
        },
      },
      "/api/accounts/alias": {
        POST: async (req) => {
          const { institution, alias, account_id } = await req.json() as {
            institution: string; alias: string; account_id: number;
          };
          if (!institution || !alias || !account_id) {
            return Response.json({ error: "institution, alias, account_id required" }, { status: 400 });
          }
          createAlias(institution, alias, account_id);
          await saveManualFacts();
          const report = await rebuild();
          return Response.json({ ok: true, rebuild: report });
        },
        DELETE: async (req) => {
          const { institution, alias } = await req.json() as { institution: string; alias: string };
          deleteAlias(institution, alias);
          await saveManualFacts();
          const report = await rebuild();
          return Response.json({ ok: true, rebuild: report });
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
          await saveManualFacts();
          return Response.json({ ok: true });
        },
        DELETE: async (req) => {
          const { id } = await req.json() as { id: number };
          getDb().run("DELETE FROM manual_balances WHERE id = ?", [id]);
          await saveManualFacts();
          return Response.json({ ok: true });
        },
      },
      "/api/import": {
        POST: async (req) => {
          const form = await req.formData();
          const files = form.getAll("file").filter((file): file is File => file instanceof File);
          if (files.length === 0) {
            return Response.json({ error: "No file provided" }, { status: 400 });
          }

          const uploadDir = join(UPLOAD_TMP, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
          await mkdir(uploadDir, { recursive: true });
          const tmpPaths: string[] = [];
          for (const [i, file] of files.entries()) {
            const fileDir = join(uploadDir, String(i));
            await mkdir(fileDir, { recursive: true });
            const tmpPath = join(fileDir, file.name);
            await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));
            tmpPaths.push(tmpPath);
          }

          // Emit SSE done/error so the Import-page reader can update per-file rows.
          let body: string;
          try {
            const reports = tmpPaths.length === 1 ? [await importFile(tmpPaths[0]!)] : await importFiles(tmpPaths);
            body = reports.map((report) => sseMessage("done", report)).join("");
          } catch (err) {
            body = sseMessage("error", { error: String(err) });
          }
          return new Response(body, {
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
