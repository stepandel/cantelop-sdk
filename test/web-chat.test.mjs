import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { CantelopClient, AppConfigurationError } from '../dist/index.js';

await promisify(execFile)(process.execPath, [new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname, '-p', new URL('../examples/web-chat/tsconfig.json', import.meta.url).pathname]);
const { createChatServer } = await import('../examples/web-chat/dist/server.js');
const sessionId = 'ses_' + '1'.repeat(32), messageId = 'msg_' + '2'.repeat(32);
const streamId = '3'.repeat(32);
const input = { sessionId, messageId, prompt: 'Hello' };
function frame(sequence, data, id = messageId) {
  return `id: ${streamId}:${sequence}\ndata: ${JSON.stringify({ stream_id: streamId, sequence, session_id: sessionId, message_id: id, created_at: '2026-10-09T00:00:00Z', data })}\n\n`;
}
async function withServer(fetchEdge, run) {
  const server = createChatServer(new CantelopClient({ sessionRuntime: { id: "test.v1", receive() {} }, connection: { fetch: fetchEdge } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function chat(url, body = input, options = {}) {
  return fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(body), ...options });
}

test('web chat sends an App command, streams its reply and excludes another message’s output', async () => {
  const calls = []; let cancelled = false;
  await withServer(async request => {
    const envelope = await request.json(); calls.push(envelope);
    assert.equal(new URL(request.url).pathname, '/commands');
    if (envelope.command.type === 'dispatch') return Response.json({ protocolVersion: 2, id: envelope.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(
        frame(1, { type: 'text_delta', delta: 'old' }, 'msg_' + '4'.repeat(32)) +
        frame(2, { type: 'text_delta', delta: 'Hello 🍈' }) + frame(3, { type: 'done', answer: 'Hello 🍈!' })
      )); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, async url => {
    const response = await chat(url);
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events, [{ type: 'accepted', messageId }, { type: 'text_delta', delta: 'Hello 🍈' }, { type: 'done', answer: 'Hello 🍈!' }]);
    assert.deepEqual(calls.map(value => value.command.type), ['dispatch', 'stream']);
    assert.deepEqual(calls[0].workspace, { slug: 'web-chat-demo' });
    assert.deepEqual(calls[0].session, { id: sessionId });
    assert.equal(calls[0].id, messageId);
    assert.deepEqual(calls[0].command, { type: 'dispatch', message: { type: 'prompt', prompt: 'Hello' }, keepAliveSeconds: 300 });
    assert.equal(cancelled, true);
    const page = await fetch(url);
    assert.match(await page.text(), /id="composer"/);
    assert.equal(page.headers.get('content-security-policy').includes("script-src 'self'"), true);
  });
});

test('web chat rejects invalid input and cross-origin requests before contacting Edge', async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error('Unexpected Edge call'); }, async url => {
    for (const value of [{ ...input, prompt: '' }, { ...input, workspace: 'other' }, { ...input, sessionId: '../other' }, { ...input, prompt: 'x'.repeat(17000) }]) assert.equal((await chat(url, value)).status, 400);
    assert.equal((await chat(url, input, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(url + '/api/chat')).status, 405);
    assert.equal((await fetch(url + '/../../package.json')).status, 404);
    assert.equal(calls, 0);
  });
});

test('configuration and broken stream errors reach the browser without secrets or automatic retries', async () => {
  await withServer(async () => { throw new AppConfigurationError('app_not_configured'); }, async url => {
    const response = await chat(url);
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(await response.text()), { type: 'error', code: 'app_not_configured', messageId });
  });
  let calls = 0;
  await withServer(async request => {
    calls++;
    const body = await request.json();
    if (body.command.type === 'dispatch') return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
    return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
  }, async url => {
    const lines = (await (await chat(url)).text()).trim().split('\n').map(JSON.parse);
    assert.equal(lines[1].code, 'chat_stream_failed');
    assert.equal(calls, 2);
  });
});

test('browser disconnect releases the SDK subscription without sending cancellation or stop', async () => {
  const commands = [];
  let release;
  const released = new Promise(resolve => { release = resolve; });
  await withServer(async request => {
    const body = await request.json(); commands.push(body.command.type);
    if (body.command.type === 'dispatch') return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(1, { type: 'text_delta', delta: 'Working' }))); },
      cancel() { release(); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, async url => {
    const controller = new AbortController();
    const response = await chat(url, input, { signal: controller.signal });
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('Working')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await released;
    reader.releaseLock();
    assert.deepEqual(commands, ['dispatch', 'stream']);
  });
});
