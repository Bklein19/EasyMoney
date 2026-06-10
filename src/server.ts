import { importFile } from "./importer";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import index from "../index.html";

const UPLOAD_TMP = join(import.meta.dir, "../imports/tmp");

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

          try {
            const report = await importFile(tmpPath);
            return Response.json(report);
          } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
          }
        },
      },
    },
    development: { hmr: true, console: true },
  });
}
