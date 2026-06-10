import React, { useState, useCallback, useRef } from "react";

interface AgentEvent {
  type: "tool_call" | "tool_result" | "message";
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}

interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  events: AgentEvent[];
  parserId?: string;
  transactionsInserted?: number;
  balancesInserted?: number;
  error?: string;
}

function argsSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([k]) => k !== "code");
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
}

function EventLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="event-log">
      {events.map((e, i) => {
        if (e.type === "message") {
          return (
            <div key={i} className="event event-message">
              <span className="event-icon">✦</span>
              <span className="event-args" style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{e.text}</span>
            </div>
          );
        }
        if (e.type === "tool_call") {
          const summary = e.args ? argsSummary(e.args) : "";
          return (
            <div key={i} className="event event-call">
              <span className="event-icon">→</span>
              <span className="event-tool">{e.tool}</span>
              {summary && <span className="event-args">{summary}</span>}
            </div>
          );
        }
        if (e.type === "tool_result") {
          const res = e.result as Record<string, unknown> | null;
          const ok = res?.["ok"];
          const errMsg = res?.["error"] as string | undefined;
          const txCount = res?.["transaction_count"] as number | undefined;
          const errors = res?.["errors"] as string[] | undefined;
          return (
            <div key={i} className={`event event-result ${ok === false ? "event-fail" : ""}`}>
              <span className="event-icon">←</span>
              <span className="event-tool">{e.tool}</span>
              {ok === true && txCount != null && (
                <span className="event-args">{txCount} transactions</span>
              )}
              {ok === false && errMsg && (
                <span className="event-args event-error-text">{errMsg}</span>
              )}
              {ok === false && errors && errors.length > 0 && (
                <span className="event-args event-error-text">{errors.slice(0, 3).join(", ")}</span>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export function ImportPage() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const appendEvent = useCallback((id: string, event: AgentEvent) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, events: [...j.events, event] } : j))
    );
  }, []);

  const importFileJob = useCallback(async (file: File) => {
    const id = `${Date.now()}-${Math.random()}`;
    setJobs((prev) => [{ id, filename: file.name, status: "pending", events: [] }, ...prev]);
    await new Promise((r) => setTimeout(r, 50));
    updateJob(id, { status: "running" });

    const body = new FormData();
    body.append("file", file);

    const res = await fetch("/api/import", { method: "POST", body });
    if (!res.ok || !res.body) {
      updateJob(id, { status: "error", error: await res.text() });
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
        if (eventLine === "agent_event") {
          appendEvent(id, data as unknown as AgentEvent);
        } else if (eventLine === "done") {
          updateJob(id, {
            status: "done",
            parserId: data["parserId"] as string,
            transactionsInserted: data["transactionsInserted"] as number,
            balancesInserted: data["balancesInserted"] as number,
          });
        } else if (eventLine === "error") {
          updateJob(id, { status: "error", error: data["error"] as string });
        }
      }
    }
  }, [updateJob, appendEvent]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) importFileJob(file);
  }, [importFileJob]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="page">
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
              <EventLog events={job.events} />
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
    </div>
  );
}
