const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const messages = document.querySelector("#messages");
const status = document.querySelector("#status");
const send = document.querySelector("#send");
const disconnect = document.querySelector("#disconnect");
const newChat = document.querySelector("#new-chat");
let sessionId = sessionStorage.getItem("cantelop-chat-session") || identity("ses");
sessionStorage.setItem("cantelop-chat-session", sessionId);
let active;

function identity(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function bubble(role, text) {
  document.querySelector("#empty")?.remove();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "You" : "Agent";
  const content = document.createElement("span");
  content.textContent = text; // Agent/user output is text, never inserted as HTML.
  article.append(label, content);
  messages.append(article);
  article.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return content;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (active || !prompt.value.trim()) return;
  const text = prompt.value.trim();
  bubble("user", text);
  const answer = bubble("agent", "");
  prompt.value = "";
  active = new AbortController();
  send.disabled = true;
  newChat.disabled = true;
  disconnect.hidden = false;
  status.textContent = "Sending…";
  let completed = false;
  let reader;
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, messageId: identity("msg"), prompt: text }), signal: active.signal,
    });
    if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error(`Chat request failed (${response.status})`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "accepted") status.textContent = "Agent is responding…";
        else if (event.type === "text_delta") answer.textContent += event.delta;
        else if (event.type === "done") { answer.textContent = event.answer; completed = true; status.textContent = "Ready"; }
        else if (event.type === "error") throw new Error(`Chat failed: ${event.code}. Work may already be admitted; this app does not retry automatically.`);
      }
      if (done) break;
    }
    if (!completed) throw new Error("Connection ended before the answer completed.");
  } catch (error) {
    status.textContent = active.signal.aborted ? "Disconnected. Agent work may continue." : error.message;
    if (!answer.textContent) answer.textContent = "No response received.";
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    active = undefined;
    send.disabled = false;
    newChat.disabled = false;
    disconnect.hidden = true;
    prompt.focus();
  }
});
disconnect.addEventListener("click", () => active?.abort());
newChat.addEventListener("click", () => {
  sessionId = identity("ses");
  sessionStorage.setItem("cantelop-chat-session", sessionId);
  messages.replaceChildren();
  status.textContent = "New conversation · Ready";
  prompt.focus();
});
