import { serve } from "@cantelop/sdk/node";
import app from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3002", 10);
const server = serve(app, { port });

server.on("listening", () => {
  console.log(`Pi example listening on http://localhost:${port}`);
});
