import type { WebhookContext } from "@cantelop/sdk";
import type { IssueMessage } from "./contracts.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function handleGitHub({ request, app, secret }: WebhookContext<IssueMessage>): Promise<Response> {
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return new Response(null, { status: 401 });
  const body = await request.arrayBuffer();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret("GITHUB_WEBHOOK_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const digest = Uint8Array.from(signature.slice(7).match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, digest, body)) return new Response(null, { status: 401 });

  let event: unknown;
  try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { return new Response(null, { status: 400 }); }
  if (request.headers.get("X-GitHub-Event") !== "issues" || !record(event) || event.action !== "opened") return new Response(null, { status: 204 });
  const { repository, issue } = event;
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!record(repository) || !Number.isSafeInteger(repository.id) || (repository.id as number) <= 0 ||
      typeof repository.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) ||
      !record(issue) || !Number.isSafeInteger(issue.number) || (issue.number as number) <= 0 || typeof issue.title !== "string" ||
      !(issue.body === null || typeof issue.body === "string") || !delivery || !/^[a-f0-9-]{36}$/.test(delivery)) return new Response(null, { status: 400 });

  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`github:${app.name}:${delivery}`)));
  const messageId = "msg_" + [...hash.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await app.workspace({ slug: `repo-${repository.id}` }).session({ id: `issue-${issue.number}` }).dispatch({
    repository: repository.full_name,
    issueNumber: issue.number as number,
    title: issue.title,
    body: issue.body ?? "",
  }, { id: messageId, signal: request.signal });
  return new Response(null, { status: 202 });
}
