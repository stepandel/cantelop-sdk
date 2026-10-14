/* eslint-disable @typescript-eslint/no-explicit-any -- Session fixture uses a broad test double. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRuntime } from '../dist/harnesses/claude.js';
import { StateStore } from '../dist/harnesses/claude-state.js';
import { ClaudeAuthenticationRequired as NativeAuthRequired, } from '../dist/harnesses/claude.js';
class FakeClaude {
    factories = [];
    runs = [];
    create = (context, options = {}) => {
        this.factories.push({ context, options });
        let resume = options.conversation?.resumable ?? false;
        return {
            queue: async (prompt, work) => {
                const turn = {
                    text: prompt.prompt,
                    signal: work.signal,
                    emit: work.output.send,
                    config: {
                        tools: options.tools,
                        allowedTools: options.allowedTools,
                        mcps: options.mcps,
                        model: options.model,
                        systemPrompt: options.systemPrompt,
                        maxTurns: options.maxTurns,
                    },
                    resume,
                    conversationId: options.conversation.id,
                };
                await work.output.send({ type: 'system', subtype: 'init', session_id: options.conversation.id });
                resume = true;
                return new Promise((resolve, reject) => {
                    this.runs.push({ turn, resolve, reject });
                    work.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    if (work.signal.aborted)
                        reject(new Error('aborted'));
                });
            },
            steer() {
                throw new Error('Durable steering is application-owned');
            },
            cancel() {
                return false;
            },
        };
    };
}
async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error('Timed out');
        await new Promise((r) => setTimeout(r, 5));
    }
}
function harness(runtime, root, settings = {}) {
    const behaviour = createClaudeRuntime({ workspace: root, permissionMode: 'dontAsk', settingSources: [], ...settings }, runtime.create), events = [];
    const replies = [];
    let activityActive = false, activityTask = Promise.resolve(), mailbox = Promise.resolve();
    const output = {
        send: async (event) => {
            events.push(event);
        },
    };
    const send = (command) => {
        mailbox = mailbox.then(() => behaviour.receive({
            signal: new AbortController().signal,
            session: { id: 'session-a', workspaceSlug: 'user', keepAliveSeconds: 300 },
            env: {},
            message: { id: crypto.randomUUID(), sequence: 1, payload: command },
            output,
            reply: (value) => {
                replies.push(value);
            },
            send: (command) => {
                void send(command);
            },
            activity,
        }));
        return mailbox;
    };
    const activity = {
        get active() {
            return activityActive;
        },
        start(work) {
            assert.equal(activityActive, false);
            activityActive = true;
            const pending = [];
            activityTask = Promise.resolve()
                .then(() => work({
                signal: new AbortController().signal,
                output,
                send: (m) => {
                    pending.push(m);
                },
            }))
                .then(() => {
                activityActive = false;
                for (const m of pending)
                    void send(m);
            });
        },
        cancel: () => false,
        extend: () => { },
    };
    const lifetime = new AbortController();
    mailbox = behaviour.onActivate({
        signal: lifetime.signal,
        session: { id: 'session-a', workspaceSlug: 'user', keepAliveSeconds: 300 },
        env: {},
        database: async () => {
            throw new Error('Database not used');
        },
        activity,
        output,
        send: async (command) => {
            void send(command);
        },
        view: { commit: async () => { } },
    });
    return {
        send,
        events,
        replies,
        behaviour,
        idle: async () => {
            await until(() => !activityActive);
            await activityTask;
            await mailbox;
        },
    };
}
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'cantelop-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runtime = new FakeClaude(), h = harness(runtime, root, {
        tools: ['Read'], allowedTools: [], mcps: {}, model: 'sonnet',
        systemPrompt: 'Persisted rules', maxTurns: 24,
    });
    await h.send({ type: 'snapshot' });
    return { root, runtime, h };
}
test('managed activity keeps mailbox responsive; steering precedes FIFO queue and resumes conversation', async (t) => {
    const { runtime, h } = await fixture(t);
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await until(() => runtime.runs.length === 1);
    await h.send({ type: 'queue', id: 'b', text: 'b' });
    await h.send({ type: 'steer', id: 'c', text: 'c' });
    await until(() => runtime.runs.length === 2);
    assert.deepEqual(runtime.runs.map((r) => r.turn.text), ['a', 'c']);
    assert.equal(runtime.runs[1].turn.resume, true);
    assert.equal(runtime.runs[1].turn.conversationId, runtime.runs[0].turn.conversationId);
    runtime.runs[1].resolve();
    await until(() => runtime.runs.length === 3);
    assert.equal(runtime.runs[2].turn.text, 'b');
    runtime.runs[2].resolve();
    await h.idle();
    assert.ok(h.events.some((e) => e.type === 'message.status' && e.id === 'a' && e.status === 'steered'));
});
test('queued cancellation, duplicate IDs and active cancellation', async (t) => {
    const { runtime, h } = await fixture(t);
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await until(() => runtime.runs.length === 1);
    await h.send({ type: 'queue', id: 'b', text: 'b' });
    await h.send({ type: 'cancel', id: 'b' });
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await h.send({ type: 'cancel', id: 'a' });
    await h.idle();
    assert.equal(runtime.runs.length, 1);
    for (const id of ['a', 'b'])
        assert.ok(h.events.some((e) => e.type === 'message.status' && e.id === id && e.status === 'cancelled'));
});
test('App configuration replaces legacy Session settings; interrupted work is not replayed', async (t) => {
    const { root, runtime } = await fixture(t);
    const store = new StateStore(root, 'session-a'), state = await store.load();
    state.resume = true;
    state.messages.push({ id: 'old', text: 'possibly ran tools', status: 'running' });
    await store.save(state);
    const replacement = harness(runtime, root, {tools: ['Write'], allowedTools: [], mcps: {}, model: 'opus', systemPrompt: 'App rules', maxTurns: 12});
    await replacement.send({ type: 'snapshot' });
    const snapshot = replacement.replies.find((e) => e.type === 'session.state');
    assert.ok(snapshot?.type === 'session.state');
    assert.equal(snapshot.messages[0]?.status, 'interrupted');
    assert.equal(runtime.runs.length, 0);
    await replacement.send({ type: 'queue', id: 'new', text: 'next' });
    await until(() => runtime.runs.length === 1);
    assert.equal(runtime.runs[0].turn.resume, true);
    assert.deepEqual(runtime.runs[0].turn.config, {tools: ['Write'], allowedTools: [], mcps: {}, model: 'opus', systemPrompt: 'App rules', maxTurns: 12});
    assert.deepEqual((await store.load()).config, runtime.runs[0].turn.config);
    runtime.runs[0].resolve();
    await replacement.idle();
});
test('signed-out failure emits auth.required without a pre-turn auth check', async (t) => {
    const { runtime, h } = await fixture(t);
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await until(() => runtime.runs.length === 1);
    runtime.runs[0].reject(new NativeAuthRequired());
    await h.idle();
    assert.ok(h.events.some((e) => e.type === 'auth.required' && e.id === 'a'));
    assert.ok(h.events.some((e) => e.type === 'message.status' && e.status === 'failed'));
});
test('forwards SDK-native fragments with application message attribution', async (t) => {
    const { runtime, h } = await fixture(t);
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await until(() => runtime.runs.length === 1);
    const fragment = { type: 'native.fragment', eventId: 'sdk-event', index: 0, total: 2, json: '{"text":"' };
    await runtime.runs[0].turn.emit(fragment);
    assert.deepEqual(h.events.find((e) => e.type === 'claude.fragment'), { ...fragment, type: 'claude.fragment', id: 'a' });
    runtime.runs[0].resolve();
    await h.idle();
});
test('SDK recovery restarts only pending work and preserves interrupted status', async (t) => {
    const { root, runtime } = await fixture(t);
    const store = new StateStore(root, 'session-a'), state = await store.load();
    state.messages.push({ id: 'running', text: 'already attempted', status: 'running' }, { id: 'pending', text: 'not started', status: 'queued' });
    state.queue = ['pending'];
    await store.save(state);
    const replacement = harness(runtime, root);
    await replacement.send({ type: 'snapshot' });
    await replacement.behaviour.onRecover({
        signal: new AbortController().signal,
        recovery: { id: 'recovery', interruptedMessageId: 'platform-id' },
        session: { id: 'session-a', workspaceSlug: 'user', keepAliveSeconds: 300 },
        env: {},
        output: {
            send: async (e) => {
                replacement.events.push(e);
            },
        },
        send: (m) => {
            void replacement.send(m);
        },
        activity: {
            active: false,
            start: () => {
                throw new Error('must dispatch drain');
            },
            cancel: () => false,
            extend: () => { },
        },
    });
    await until(() => runtime.runs.length === 1);
    assert.equal(runtime.runs[0].turn.text, 'not started');
    runtime.runs[0].resolve();
    await replacement.idle();
    assert.equal((await store.load()).messages.find((m) => m.id === 'running')?.status, 'interrupted');
});
test('terminal native auth failure emits auth.required for the affected message', async (t) => {
    const { runtime, h } = await fixture(t);
    const id = crypto.randomUUID();
    await h.send({ type: 'queue', id, text: 'test' });
    await until(() => runtime.runs.length === 1);
    runtime.runs[0].reject(new NativeAuthRequired());
    await until(() => h.events.some((e) => e.type === 'auth.required'));
    assert.ok(h.events.some((e) => e.type === 'auth.required' && e.id === id));
});
test('uses one configured SDK factory per incarnation with a separate lifetime and turn signal', async (t) => {
    const { runtime, h } = await fixture(t);
    await h.send({ type: 'queue', id: 'a', text: 'a' });
    await until(() => runtime.runs.length === 1);
    assert.equal(runtime.factories.length, 1);
    const { context, options } = runtime.factories[0];
    assert.equal(context.session.id, 'session-a');
    assert.notEqual(context.signal, runtime.runs[0].turn.signal);
    assert.deepEqual(options.tools, ['Read']);
    assert.deepEqual(options.allowedTools, []);
    assert.deepEqual(options.mcps, {});
    assert.equal(options.permissionMode, 'dontAsk');
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.systemPrompt, 'Persisted rules');
    assert.equal(options.maxTurns, 24);
    await h.send({ type: 'cancel', id: 'a' });
    await h.idle();
    assert.equal(context.signal.aborted, false, 'Cancelling a turn must not poison the Session factory');
    await h.send({ type: 'queue', id: 'b', text: 'b' });
    await until(() => runtime.runs.length === 2);
    assert.equal(runtime.factories.length, 1);
    runtime.runs[1].resolve();
    await h.idle();
});

test('invalid configuration is rejected before persistence or native harness creation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-invalid-config-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const runtime = new FakeClaude();
  assert.throws(() => harness(runtime, root, {tools:['--unsafe']}), /Invalid tool arrays/);
  assert.equal((await new StateStore(root,'session-a').load()).config, undefined);
  assert.equal(runtime.factories.length, 0);
});


test('first task uses snapshotted App settings without a configure request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-app-settings-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const runtime = new FakeClaude();
  const settings = {tools:['Read'], allowedTools:['Read'], mcps:{docs:{type:'http',url:'https://docs.example/mcp'}}, model:'sonnet', systemPrompt:'App rules', maxTurns:8};
  const expected = structuredClone(settings);
  const h = harness(runtime, root, settings);
  settings.tools.push('Write');
  settings.mcps.docs.url = 'https://changed.example/mcp';
  await h.send({type:'queue',id:'first',text:'Start'});
  await until(() => runtime.runs.length === 1);
  assert.deepEqual(runtime.runs[0].turn.config, expected);
  assert.ok(h.events.some(e => e.type === 'session.ready'));
  runtime.runs[0].resolve();
  await h.idle();
});

test('omitted App settings preserve native defaults and allow immediate tasks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cantelop-stock-settings-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const runtime = new FakeClaude(), h = harness(runtime, root);
  await h.send({type:'snapshot'});
  assert.equal(h.replies[0].configured, true);
  await h.send({type:'queue',id:'first',text:'Start'});
  await until(() => runtime.runs.length === 1);
  for (const key of ['tools','allowedTools','mcps','model','systemPrompt','maxTurns'])
    assert.equal(runtime.factories[0].options[key], undefined);
  runtime.runs[0].resolve();
  await h.idle();
});
