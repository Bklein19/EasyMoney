import { importFile } from "./importer";
import type { AgentEvent } from "./agent";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import index from "../index.html";

const UPLOAD_TMP = join(import.meta.dir, "../imports/tmp");

function sse(stream: ReadableStream) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function sseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function startServer(port = Number(process.env["PORT"] ?? 3000)) {
  return Bun.serve({
    port,
    routes: {
      "/": index,
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
          const stream = new ReadableStream<string>({
            start(c) { controller = c; },
          });

          const onEvent = (event: AgentEvent) => {
            controller!.enqueue(sseMessage("agent_event", event));
          };

          importFile(tmpPath, onEvent)
            .then((report) => {
              controller!.enqueue(sseMessage("done", report));
              controller!.close();
            })
            .catch((err) => {
              controller!.enqueue(sseMessage("error", { error: String(err) }));
              controller!.close();
            });

          return sse(stream);
        },
      },
    },
    development: { hmr: true, console: true },
  });
}
