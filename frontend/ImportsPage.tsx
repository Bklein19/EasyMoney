import React, { useCallback, useEffect, useRef, useState } from "react";

interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  parserId?: string;
  transactionsInserted?: number;
  balancesInserted?: number;
  autoCreatedAccounts?: number;
  error?: string;
}

interface ImportRecord {
  id: number;
  filename: string;
  status: string;
  parser_id: string | null;
  covered_from: string | null;
  covered_to: string | null;
  imported_at: string;
  transactions_count: number;
  balances_count: number;
  accounts: string[];
}

export function ImportsPage() {
  const [records, setRecords] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshRecords = useCallback(() => {
    setLoading(true);
    return fetch("/api/imports")
      .then((r) => r.json())
      .then((data) => { setRecords(data); setLoading(false); });
  }, []);

  useEffect(() => {
    refreshRecords();
  }, [refreshRecords]);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const importFileJobs = useCallback(async (files: File[]) => {
    const batch = files.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      file,
    }));
    setJobs((prev) => [
      ...batch.map(({ id, file }) => ({ id, filename: file.name, status: "pending" as const })),
      ...prev,
    ]);
    await new Promise((r) => setTimeout(r, 50));
    for (const { id } of batch) updateJob(id, { status: "running" });

    const body = new FormData();
    for (const { file } of batch) body.append("file", file);

    const res = await fetch("/api/import", { method: "POST", body });
    if (!res.ok || !res.body) {
      const error = await res.text();
      for (const { id } of batch) updateJob(id, { status: "error", error });
      return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const messages = buf.split("\n\n");
      buf = messages.pop() ?? "";
      for (const msg of messages) {
        const eventLine = msg.match(/^event: (.+)$/m)?.[1];
        const dataLine = msg.match(/^data: (.+)$/m)?.[1];
        if (!eventLine || !dataLine) continue;
        const data = JSON.parse(dataLine) as Record<string, unknown>;
        if (eventLine === "done") {
          const next = batch.shift();
          if (!next) continue;
          updateJob(next.id, {
            status: "done",
            parserId: data["parserId"] as string,
            transactionsInserted: data["transactionsInserted"] as number,
            balancesInserted: data["balancesInserted"] as number,
            autoCreatedAccounts: Array.isArray(data["autoCreatedAccounts"])
              ? data["autoCreatedAccounts"].length
              : 0,
          });
        } else if (eventLine === "error") {
          for (const { id } of batch) updateJob(id, { status: "error", error: data["error"] as string });
        }
      }
    }
    refreshRecords();
  }, [refreshRecords, updateJob]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    importFileJobs(Array.from(files));
  }, [importFileJobs]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="page page-imports">
      <div
        className={`drop-zone imports-drop-zone${over ? " over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.pdf,.ofx,.qfx,.qbo"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="drop-icon">↑</div>
        <div className="drop-label">
          Drop files here or <span>browse</span>
        </div>
        <div className="drop-hint">CSV, PDF, OFX, QFX supported</div>
      </div>

      {jobs.length > 0 && (
        <div className="status imports-status">
          {jobs.map((job) => (
            <div key={job.id} className="status-item">
              <div className="status-item-header">
                <span className="filename">{job.filename}</span>
                <span className={`badge ${job.status}`}>{job.status}</span>
              </div>
              {job.parserId && (
                <div className="meta">parser: {job.parserId}</div>
              )}
              {job.status === "done" && (
                <div className="stats">
                  <strong>{job.transactionsInserted}</strong> transactions &nbsp;·&nbsp;{" "}
                  <strong>{job.balancesInserted}</strong> balances
                  {job.autoCreatedAccounts ? (
                    <>
                      {" "}&nbsp;·&nbsp; <strong>{job.autoCreatedAccounts}</strong> new account
                      {job.autoCreatedAccounts === 1 ? "" : "s"}
                    </>
                  ) : null}
                </div>
              )}
              {job.error && (
                <div className="meta import-error">{job.error}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 className="imports-heading">
        Imported files <span>({records.length})</span>
      </h2>
      {loading ? (
        <div className="meta">Loading...</div>
      ) : (
      <table className="imports-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Coverage</th>
            <th>Accounts</th>
            <th className="num">Txns</th>
            <th className="num">Balances</th>
            <th>Parser</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td className="imports-file-cell">
                <span
                  className={r.status === "ok" ? "imports-file-name" : "imports-file-name error"}
                  title={r.filename}
                >
                  {r.filename}
                </span>
                <span className="imports-file-date">
                  {r.imported_at.slice(0, 10)}
                </span>
              </td>
              <td className="imports-coverage">
                {r.covered_from && r.covered_to
                  ? r.covered_from === r.covered_to
                    ? r.covered_from
                    : `${r.covered_from} - ${r.covered_to}`
                  : <span className="muted">—</span>}
              </td>
              <td className="imports-accounts">
                {r.accounts.length > 0
                  ? r.accounts.join(", ")
                  : <span className="muted">—</span>}
              </td>
              <td className={`num ${r.transactions_count > 0 ? "" : "muted"}`}>
                {r.transactions_count || "—"}
              </td>
              <td className={`num ${r.balances_count > 0 ? "" : "muted"}`}>
                {r.balances_count || "—"}
              </td>
              <td className="imports-parser">
                {r.parser_id ?? <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
