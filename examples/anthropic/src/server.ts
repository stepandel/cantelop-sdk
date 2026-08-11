import { serve } from "@cantelop/sdk/node";
import app from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const server = serve(app, { port });

server.on("listening", () => {
  console.log(`Anthropic example listening on http://localhost:${port}`);
});
