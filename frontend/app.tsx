import React, { useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";

interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  parserId?: string;
  transactionsInserted?: number;
  balancesInserted?: number;
  error?: string;
}

function App() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const importFile = useCallback(async (file: File) => {
    const id = `${Date.now()}-${Math.random()}`;
    setJobs((prev) => [{ id, filename: file.name, status: "pending" }, ...prev]);

    await new Promise((r) => setTimeout(r, 50)); // let render flush
    updateJob(id, { status: "running" });

    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error((data["error"] as string) ?? res.statusText);
      updateJob(id, {
        status: "done",
        parserId: data["parserId"] as string,
        transactionsInserted: data["transactionsInserted"] as number,
        balancesInserted: data["balancesInserted"] as number,
      });
    } catch (err) {
      updateJob(id, { status: "error", error: String(err) });
    }
  }, [updateJob]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) importFile(file);
  }, [importFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <>
      <h1>Personal Finance Observatory</h1>

      <div
        className={`drop-zone${over ? " over" : ""}`}
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
        <div className="status">
          {jobs.map((job) => (
            <div key={job.id} className="status-item">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
                </div>
              )}
              {job.error && (
                <div className="meta" style={{ color: "#e05252" }}>{job.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const root = createRoot(document.body);
root.render(<App />);
