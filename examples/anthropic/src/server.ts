import { createServer } from "node:http";
import app from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);

createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of incoming) chunks.push(chunk);

    const init: RequestInit = {
      method: incoming.method ?? "GET",
      headers,
    };
    if (chunks.length > 0) {
      init.body = new Uint8Array(Buffer.concat(chunks));
    }

    const request = new Request(
      `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`,
      init,
    );

    const response = await app.handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500).end("Internal Server Error");
  }
}).listen(port, () => {
  console.log(`Anthropic example listening on http://localhost:${port}`);
});
