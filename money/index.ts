import { startServer } from "./src/server";

const server = startServer();
console.log(`Listening on http://localhost:${server.port}`);
