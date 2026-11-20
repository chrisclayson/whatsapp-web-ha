import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createBridgeServer } from '../src/server.js';

class FakeSession {
  constructor() {
    this.status = 'connected';
    this.instanceId = 'instance-1';
    this.listeners = new Set();
    this.calls = [];
    this.state = {
      instance_id: 'instance-1',
      status: 'connected',
      me: { id: '15550000000@s.whatsapp.net', name: 'Tester' },
      pairing: null,
      unread: { total: 2 },
      chats: [{ id: '15550001111@s.whatsapp.net', unread: 2 }],
      version: '1.0.0',
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, data) {
    for (const listener of this.listeners) listener({ type, data, at: 'now' });
  }

  getState() {
    return this.state;
  }

  getChats() {
    return this.state.chats;
  }

  async start(options) {
    this.calls.push(['start', options]);
    return this.state;
  }

  async cancelPairing() {
    this.calls.push(['cancelPairing']);
  }

  async logout() {
    this.calls.push(['logout']);
  }

  async sendText(options) {
    this.calls.push(['sendText', options]);
    return { message_id: 'm1', chat_id: options.to, timestamp: 1 };
  }

  async markRead(options) {
    this.calls.push(['markRead', options]);
    return { ok: true, chat: options.chat, marked: 1 };
  }

  async sendTyping(options) {
    this.calls.push(['sendTyping', options]);
    return { ok: true, ...options };
  }
}

function logger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

async function startServer({ token = 'test-token-abcdefgh' } = {}) {
  const session = new FakeSession();
  const { server, close } = createBridgeServer({
    session,
    config: { token, version: '1.0.0', corsOrigin: '' },
    logger: logger(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { session, close, base: `http://127.0.0.1:${port}`, port };
}

test('health check is public, API routes require the token', async () => {
  const { close, base } = await startServer();
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(`${base}/api/state`);
    assert.equal(unauthorized.status, 401);

    const wrong = await fetch(`${base}/api/state`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/api/state`, {
      headers: { authorization: 'Bearer test-token-abcdefgh' },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).instance_id, 'instance-1');
  } finally {
    await close();
  }
});

test('routes commands to the session', async () => {
  const { session, close, base } = await startServer();
  const headers = {
    authorization: 'Bearer test-token-abcdefgh',
    'content-type': 'application/json',
  };
  try {
    const pair = await fetch(`${base}/api/pair/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'phone', phone: '+15550001111' }),
    });
    assert.equal(pair.status, 200);
    assert.deepEqual(session.calls.at(-1), [
      'start',
      { method: 'phone', phone: '+15550001111', timeoutMs: 25000 },
    ]);

    const send = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: '15550002222', message: 'hello' }),
    });
    assert.equal(send.status, 200);
    assert.deepEqual(session.calls.at(-1), [
      'sendText',
      { to: '15550002222', text: 'hello' },
    ]);

    const read = await fetch(`${base}/api/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat: '15550002222@s.whatsapp.net' }),
    });
    assert.equal(read.status, 200);
    assert.deepEqual(session.calls.at(-1), [
      'markRead',
      { chat: '15550002222@s.whatsapp.net', messageIds: null },
    ]);

    const typing = await fetch(`${base}/api/typing`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat: '15550002222@s.whatsapp.net', state: 'composing' }),
    });
    assert.equal(typing.status, 200);
    assert.deepEqual(session.calls.at(-1), [
      'sendTyping',
      { chat: '15550002222@s.whatsapp.net', state: 'composing' },
    ]);
  } finally {
    await close();
  }
});

test('rejects invalid JSON and phone pairing without a number', async () => {
  const { close, base } = await startServer();
  const headers = {
    authorization: 'Bearer test-token-abcdefgh',
    'content-type': 'application/json',
  };
  try {
    const invalid = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers,
      body: '{not json',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_json');

    const noPhone = await fetch(`${base}/api/pair/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'phone' }),
    });
    assert.equal(noPhone.status, 400);
    assert.equal((await noPhone.json()).error.code, 'invalid_phone');
  } finally {
    await close();
  }
});

test('streams hello and session events over the websocket', async () => {
  const { session, close, base, port } = await startServer();
  const url = `ws://127.0.0.1:${port}/ws?token=test-token-abcdefgh`;
  const ws = new WebSocket(url);
  const frames = [];
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

    const deadline = Date.now() + 2000;
    while (!frames.some((frame) => frame.type === 'hello')) {
      if (Date.now() > deadline) throw new Error('no hello frame');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    session.emit('message', { message_id: 'm1', text: 'hi' });
    while (!frames.some((frame) => frame.type === 'message')) {
      if (Date.now() > deadline) throw new Error('no message frame');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      frames.find((frame) => frame.type === 'message').data.text,
      'hi',
    );
  } finally {
    ws.close();
    await close();
  }
});

test('rejects websocket upgrades without a token', async () => {
  const { close, port } = await startServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    );
  } finally {
    ws.terminate();
    await close();
  }
});
