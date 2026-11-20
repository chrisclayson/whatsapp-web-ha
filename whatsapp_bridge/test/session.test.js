import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WhatsAppSession } from '../src/session.js';

const ME = '15550000000@s.whatsapp.net';
const ALICE = '15550001111@s.whatsapp.net';

class FakeSocket {
  constructor() {
    this.ev = new EventEmitter();
    this.user = { id: '15550000000:2@s.whatsapp.net', name: 'Tester' };
    this.sentMessages = [];
    this.readBatches = [];
    this.pairingRequests = [];
    this.presence = [];
    this.ended = false;
    this.loggedOut = false;
  }

  async sendMessage(jid, content) {
    this.sentMessages.push({ jid, content });
    return {
      key: { remoteJid: jid, fromMe: true, id: `out-${this.sentMessages.length}` },
      message: { conversation: content.text },
      messageTimestamp: 1700000010,
      pushName: 'Tester',
    };
  }

  async readMessages(keys) {
    this.readBatches.push(keys);
  }

  async sendPresenceUpdate(state, jid) {
    this.presence.push({ state, jid });
  }

  async requestPairingCode(phone) {
    this.pairingRequests.push(phone);
    return 'ABCD1234';
  }

  async onWhatsApp(number) {
    if (number === '000') return [{ exists: false }];
    return [{ exists: true, jid: `${number}@s.whatsapp.net` }];
  }

  end() {
    this.ended = true;
  }

  async logout() {
    this.loggedOut = true;
  }
}

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    child() {
      return this;
    },
  };
}

async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createHarness() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatsapp-bridge-'));
  const sockets = [];
  const deps = {
    useMultiFileAuthState: async () => ({
      state: { creds: {} },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    makeWASocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    Browsers: { macOS: () => ['Mac OS', 'Desktop', '1.0'] },
    DisconnectReason: {
      loggedOut: 401,
      connectionReplaced: 440,
      restartRequired: 515,
    },
    normalizeMessageContent: (content) => content,
  };

  const session = new WhatsAppSession({
    dataDir: dir,
    logger: logger(),
    deps,
    config: { version: 'test', maxChats: 50 },
    qrEncoder: async () => 'data:image/png;base64,QR',
  });
  await session.init();

  const events = [];
  session.subscribe((event) => events.push(event));
  return { session, dir, sockets, events };
}

test('QR pairing exposes a rendered QR and then connects', async () => {
  const { session, sockets } = await createHarness();
  const starting = session.start({ method: 'qr', timeoutMs: 1000 });
  await waitFor(() => sockets.length === 1);

  sockets[0].ev.emit('connection.update', { qr: 'raw-qr-data' });
  const state = await starting;

  assert.equal(state.status, 'pairing');
  assert.equal(state.pairing.method, 'qr');
  assert.equal(state.pairing.qr, 'data:image/png;base64,QR');
  assert.equal(state.pairing.qr_data, 'raw-qr-data');

  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => session.status === 'connected');
  assert.equal(session.me.id, ME);
  assert.equal(session.me.phone, '15550000000');
  assert.equal(session.getState().pairing, null);

  await session.close();
});

test('phone pairing requests a code after the QR handshake', async () => {
  const { session, sockets } = await createHarness();
  const starting = session.start({
    method: 'phone',
    phone: '+1 (555) 000-1111',
    timeoutMs: 1000,
  });
  await waitFor(() => sockets.length === 1);

  sockets[0].ev.emit('connection.update', { qr: 'raw-qr-data' });
  const state = await starting;

  assert.deepEqual(sockets[0].pairingRequests, ['15550001111']);
  assert.equal(state.pairing.code, 'ABCD-1234');

  await session.close();
});

test('tracks unread counts, messages and mark-as-read keys', async () => {
  const { session, sockets, events } = await createHarness();
  const starting = session.start({ method: 'qr', timeoutMs: 1000 });
  await waitFor(() => sockets.length === 1);
  sockets[0].ev.emit('connection.update', { qr: 'raw' });
  await starting;
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => session.status === 'connected');

  sockets[0].ev.emit('chats.upsert', [
    {
      id: ALICE,
      name: 'Alice',
      unreadCount: 2,
      conversationTimestamp: 1700000000,
    },
  ]);
  await waitFor(() => session.tracker.total() === 2);

  const upsert = {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: ALICE, fromMe: false, id: 'm1' },
        message: { conversation: 'hello' },
        messageTimestamp: 1700000005,
        pushName: 'Alice',
      },
    ],
  };
  sockets[0].ev.emit('messages.upsert', upsert);
  sockets[0].ev.emit('messages.upsert', upsert);
  await waitFor(() => events.some((event) => event.type === 'message'));
  await waitFor(() => session.tracker.total() === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    events.filter((event) => event.type === 'message').length,
    1,
  );

  const messageEvent = events.find((event) => event.type === 'message');
  assert.equal(messageEvent.data.text, 'hello');
  assert.equal(messageEvent.data.chat_name, 'Alice');

  const result = await session.markRead({ chat: ALICE });
  assert.equal(result.marked, 1);
  assert.deepEqual(sockets[0].readBatches[0], [{ remoteJid: ALICE, id: 'm1' }]);
  assert.equal(session.tracker.total(), 0);

  await session.close();
});

test('sends text to a phone number and emits a sent message', async () => {
  const { session, sockets, events } = await createHarness();
  const starting = session.start({ method: 'qr', timeoutMs: 1000 });
  await waitFor(() => sockets.length === 1);
  sockets[0].ev.emit('connection.update', { qr: 'raw' });
  await starting;
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => session.status === 'connected');

  const result = await session.sendText({
    to: '+1 555 000 2222',
    text: 'ping',
  });

  assert.equal(result.chat_id, '15550002222@s.whatsapp.net');
  assert.deepEqual(sockets[0].sentMessages[0], {
    jid: '15550002222@s.whatsapp.net',
    content: { text: 'ping' },
  });
  const sent = events.find(
    (event) => event.type === 'message' && event.data.from_me,
  );
  assert.equal(sent.data.text, 'ping');

  await session.close();
});

test('rejects sending while disconnected', async () => {
  const { session } = await createHarness();
  await assert.rejects(
    session.sendText({ to: '15550002222', text: 'nope' }),
    /not connected/i,
  );
  await session.close();
});

test('connectionReplaced stops instead of reconnecting', async () => {
  const { session, sockets } = await createHarness();
  const starting = session.start({ method: 'qr', timeoutMs: 1000 });
  await waitFor(() => sockets.length === 1);
  sockets[0].ev.emit('connection.update', { qr: 'raw' });
  await starting;
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => session.status === 'connected');

  sockets[0].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 440 } } },
  });
  await waitFor(() => session.status === 'disconnected');
  assert.match(session.lastError, /replaced/i);
  assert.equal(sockets.length, 1);

  await session.close();
});

test('logout clears auth, chats and the session status', async () => {
  const { session, sockets, dir } = await createHarness();
  const starting = session.start({ method: 'qr', timeoutMs: 1000 });
  await waitFor(() => sockets.length === 1);
  sockets[0].ev.emit('connection.update', { qr: 'raw' });
  await starting;
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await waitFor(() => session.status === 'connected');

  sockets[0].ev.emit('chats.upsert', [{ id: ALICE, unreadCount: 1 }]);
  await waitFor(() => session.tracker.total() === 1);

  await session.logout();
  assert.equal(sockets[0].loggedOut, true);
  assert.equal(session.status, 'logged_out');
  assert.equal(session.tracker.total(), 0);
  assert.equal(session.getState().me, null);

  await assert.rejects(
    fsp.access(path.join(dir, 'auth', 'creds.json')),
    /ENOENT/,
  );
});
