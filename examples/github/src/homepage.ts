export function homepage(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub issue agent</title></head>
<body><main><h1>GitHub issue agent</h1><p>This agent responds to newly opened GitHub issues with a suggested next step.</p></main></body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
