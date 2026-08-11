import { serve } from "@cantelop/sdk/node";
import app from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = serve(app, { port });

server.on("listening", () => {
  console.log(`OpenAI example listening on http://localhost:${port}`);
});
