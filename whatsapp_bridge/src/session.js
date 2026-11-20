import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

import { BridgeError, NotConnectedError, PairingTimeoutError } from './errors.js';
import { normalizeMessage, toPublicMessage } from './message.js';
import { JsonStore } from './store.js';
import { UnreadTracker } from './unread.js';
import {
  formatPairingCode,
  jidToPhone,
  normalizeJidUser,
  normalizePhone,
  nowSeconds,
  toSeconds,
} from './util.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const PAIRING_TIMEOUT_MS = 25000;
const UNREAD_DEBOUNCE_MS = 100;

/**
 * Owns one Baileys socket, the persisted auth state and the unread tracker.
 *
 * Baileys itself is injected through `deps` so the pairing/unread logic can be
 * unit tested with a fake socket, without opening a real WhatsApp connection.
 */
export class WhatsAppSession {
  constructor({
    dataDir,
    logger,
    deps,
    config = {},
    qrEncoder = (value) =>
      QRCode.toDataURL(value, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      }),
  }) {
    this.dataDir = dataDir;
    this.authDir = path.join(dataDir, 'auth');
    this.logger = logger;
    this.deps = deps;
    this.config = config;
    this.qrEncoder = qrEncoder;
    this.bridgeVersion = config.version ?? '0.0.0';

    this.events = new EventEmitter();
    this.tracker = new UnreadTracker({ maxChats: config.maxChats ?? 500 });
    this.store = new JsonStore(path.join(dataDir, 'state.json'), {
      logger,
    });

    this.instanceId = null;
    this.sock = null;
    this.creds = null;
    this.status = 'disconnected';
    this.me = null;
    this.pairing = null;
    this.pairingMethod = null;
    this.phone = null;
    this.pairingCodeRequested = false;
    this.lastError = null;
    this.connectedAt = null;

    this.generation = 0;
    this.connecting = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pairingWaiters = new Set();
    this.unreadTimer = null;
    this.groupCache = new Map();
    this.recentEventIds = [];
    this.stopping = false;
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.authDir, { recursive: true });

    const instanceFile = path.join(this.dataDir, 'instance.json');
    try {
      const data = JSON.parse(await fsp.readFile(instanceFile, 'utf8'));
      if (typeof data.instance_id === 'string' && data.instance_id) {
        this.instanceId = data.instance_id;
      }
    } catch {
      // First start.
    }
    if (!this.instanceId) {
      this.instanceId = crypto.randomUUID();
      await fsp.writeFile(
        instanceFile,
        JSON.stringify({ instance_id: this.instanceId }, null, 2),
        { mode: 0o600 },
      );
    }

    const saved = await this.store.load();
    if (saved) this.tracker.load(saved);

    this.logger?.info(
      { instanceId: this.instanceId, paired: this.hasSession() },
      'session initialised',
    );
  }

  hasSession() {
    try {
      const raw = fsSync.readFileSync(path.join(this.authDir, 'creds.json'), 'utf8');
      return Boolean(JSON.parse(raw)?.me?.id);
    } catch {
      return false;
    }
  }

  subscribe(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  emit(type, data) {
    this.events.emit('event', {
      type,
      data,
      at: new Date().toISOString(),
    });
  }

  getState() {
    return {
      instance_id: this.instanceId,
      status: this.status,
      me: this.me,
      pairing: this.pairing,
      unread: { total: this.tracker.total() },
      chats: this.tracker.snapshot({ limit: 200 }),
      version: this.bridgeVersion,
      last_error: this.lastError,
      connected_at: this.connectedAt,
    };
  }

  getChats() {
    return this.tracker.snapshot({ limit: 500 });
  }

  /** Restore a stored session at boot without blocking on pairing. */
  async startAuto() {
    if (!this.hasSession()) {
      this.status = 'disconnected';
      this.logger?.info('no stored WhatsApp session; waiting for pairing');
      return;
    }
    await this.start({ waitForPairing: false }).catch((err) => {
      this.logger?.error({ err }, 'auto connect failed');
    });
  }

  async start({
    method = 'qr',
    phone,
    waitForPairing = true,
    timeoutMs = PAIRING_TIMEOUT_MS,
  } = {}) {
    if (this.status === 'connected') return this.getState();

    if (method === 'phone') {
      try {
        this.phone = normalizePhone(phone);
      } catch (err) {
        throw new BridgeError(err.message, {
          status: 400,
          code: 'invalid_phone',
        });
      }
    } else {
      this.phone = null;
    }
    this.pairingMethod = method;
    this.stopping = false;

    if (!this.sock) {
      this.status = 'connecting';
      this.emitConnection();
      await this.#connect();
    }

    if (waitForPairing) {
      await this.#waitForPairing(timeoutMs);
      if (this.pairing?.error) {
        throw new BridgeError(this.pairing.error, {
          status: 502,
          code: 'pairing_failed',
        });
      }
    }
    return this.getState();
  }

  async stop() {
    this.stopping = true;
    this.generation += 1;
    this.#clearReconnectTimer();
    this.#clearUnreadTimer();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        sock.end?.(undefined);
      } catch (err) {
        this.logger?.debug({ err }, 'error while closing socket');
      }
    }
    this.status = 'disconnected';
    this.connectedAt = null;
    this.pairing = null;
    this.pairingMethod = null;
    this.pairingCodeRequested = false;
    this.emitConnection();
    this.#persist();
    await this.store.flush();
    this.stopping = false;
  }

  async cancelPairing() {
    await this.stop();
    return { ok: true };
  }

  async logout() {
    this.stopping = true;
    this.generation += 1;
    this.#clearReconnectTimer();
    const sock = this.sock;
    this.sock = null;
    try {
      await sock?.logout?.();
    } catch (err) {
      this.logger?.warn({ err }, 'logout request failed');
    }
    try {
      sock?.end?.(undefined);
    } catch {
      // ignore
    }

    await this.#clearAuth();
    this.tracker.clear();
    this.me = null;
    this.creds = null;
    this.status = 'logged_out';
    this.connectedAt = null;
    this.pairing = null;
    this.pairingMethod = null;
    this.phone = null;
    this.pairingCodeRequested = false;
    this.lastError = null;
    this.emitConnection();
    this.emitUnreadNow();
    this.#persist();
    await this.store.flush();
    this.stopping = false;
    return { ok: true };
  }

  async sendText({ to, text }) {
    const sock = this.#requireSock();
    if (typeof to !== 'string' || !to.trim()) {
      throw new BridgeError('Recipient is required', {
        status: 400,
        code: 'invalid_recipient',
      });
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new BridgeError('Message text is required', {
        status: 400,
        code: 'invalid_message',
      });
    }

    const jid = await this.#resolveJid(to);
    let sent;
    try {
      sent = await sock.sendMessage(jid, { text });
    } catch (err) {
      throw new BridgeError(`WhatsApp rejected the message: ${err.message}`, {
        status: 502,
        code: 'send_failed',
      });
    }

    const message = normalizeMessage(sent, {
      meId: this.me?.id,
      chatName: this.tracker.nameFor(jid),
      contentNormalizer: this.deps.normalizeMessageContent,
    });
    if (message) {
      this.tracker.noteMessage(message);
      this.emit(
        'message',
        toPublicMessage(message, {
          chatName: this.tracker.nameFor(message.chatId),
          receivedAt: new Date().toISOString(),
          unreadTotal: this.tracker.total(),
        }),
      );
      this.#persist();
    }

    return {
      message_id: sent?.key?.id ?? null,
      chat_id: sent?.key?.remoteJid ?? jid,
      timestamp: toSeconds(sent?.messageTimestamp) || nowSeconds(),
    };
  }

  async markRead({ chat, messageIds = null }) {
    const sock = this.#requireSock();
    if (typeof chat !== 'string' || !chat) {
      throw new BridgeError('chat is required', {
        status: 400,
        code: 'invalid_chat',
      });
    }
    if (messageIds !== null && !Array.isArray(messageIds)) {
      throw new BridgeError('message_ids must be an array', {
        status: 400,
        code: 'invalid_message_ids',
      });
    }

    const keys =
      Array.isArray(messageIds) && messageIds.length
        ? messageIds
            .filter((id) => typeof id === 'string' && id)
            .map((id) => ({ remoteJid: chat, id }))
        : this.tracker.recentKeys(chat);

    if (keys.length) {
      try {
        await sock.readMessages(keys);
      } catch (err) {
        throw new BridgeError(`Could not mark messages as read: ${err.message}`, {
          status: 502,
          code: 'read_failed',
        });
      }
    }

    this.tracker.markRead(chat);
    this.emitUnreadNow();
    this.#persist();
    return { ok: true, chat, marked: keys.length };
  }

  async sendTyping({ chat, state = 'composing' }) {
    const sock = this.#requireSock();
    if (typeof chat !== 'string' || !chat) {
      throw new BridgeError('chat is required', {
        status: 400,
        code: 'invalid_chat',
      });
    }
    const presence = state === 'paused' ? 'paused' : 'composing';
    try {
      await sock.sendPresenceUpdate(presence, chat);
    } catch (err) {
      throw new BridgeError(`Could not update presence: ${err.message}`, {
        status: 502,
        code: 'presence_failed',
      });
    }
    return { ok: true, chat, state: presence };
  }

  #requireSock() {
    if (!this.sock || this.status !== 'connected') throw new NotConnectedError();
    return this.sock;
  }

  async #resolveJid(to) {
    const value = to.trim();
    if (value.includes('@')) return value;

    const digits = value.replace(/[^\d]/g, '');
    if (!digits) {
      throw new BridgeError('Recipient must be a phone number or a JID', {
        status: 400,
        code: 'invalid_recipient',
      });
    }
    let results;
    try {
      results = await this.sock.onWhatsApp(digits);
    } catch (err) {
      throw new BridgeError(`Could not look up the number: ${err.message}`, {
        status: 502,
        code: 'lookup_failed',
      });
    }
    const result = Array.isArray(results) ? results[0] : results;
    if (result && result.exists === false) {
      throw new BridgeError('That phone number is not on WhatsApp', {
        status: 404,
        code: 'not_on_whatsapp',
      });
    }
    return result?.jid ?? `${digits}@s.whatsapp.net`;
  }

  async #connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.#doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #doConnect() {
    if (this.stopping || this.status === 'logged_out') return;

    const generation = ++this.generation;
    this.logger?.info({ attempt: this.reconnectAttempt }, 'connecting to WhatsApp');

    let authState;
    try {
      authState = await this.deps.useMultiFileAuthState(this.authDir);
    } catch (err) {
      this.lastError = `Could not load the stored session: ${err.message}`;
      this.status = 'error';
      this.emitConnection();
      throw new BridgeError(this.lastError, {
        status: 500,
        code: 'session_load_failed',
      });
    }
    this.creds = authState.state.creds;

    let version;
    try {
      ({ version } = await this.deps.fetchLatestBaileysVersion());
    } catch (err) {
      this.logger?.warn({ err }, 'could not fetch the latest Baileys version');
    }

    let sock;
    try {
      sock = this.deps.makeWASocket({
        auth: authState.state,
        logger: this.config.baileysLogger ?? this.logger,
        browser: this.deps.Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: () => true,
        getMessage: async () => undefined,
        cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
        ...(version ? { version } : {}),
      });
    } catch (err) {
      this.lastError = `Could not create the WhatsApp socket: ${err.message}`;
      this.status = 'error';
      this.emitConnection();
      throw new BridgeError(this.lastError, {
        status: 502,
        code: 'socket_create_failed',
      });
    }

    this.sock = sock;
    this.#bindSocket(sock, generation, authState.saveCreds);
  }

  #bindSocket(sock, generation, saveCreds) {
    const guard = (handler) => {
      return (...args) => {
        if (generation !== this.generation) return;
        Promise.resolve(handler(...args)).catch((err) => {
          this.logger?.error({ err }, 'unhandled session event error');
        });
      };
    };

    sock.ev.on('creds.update', guard(saveCreds));
    sock.ev.on(
      'connection.update',
      guard((update) => this.#handleConnectionUpdate(update)),
    );
    sock.ev.on(
      'messages.upsert',
      guard((payload) => this.#handleMessagesUpsert(payload)),
    );
    sock.ev.on(
      'chats.upsert',
      guard((chats) => this.#handleChats(chats, { seed: true })),
    );
    sock.ev.on(
      'chats.update',
      guard((chats) => this.#handleChats(chats, { seed: false })),
    );
    sock.ev.on(
      'contacts.upsert',
      guard((contacts) => this.#handleContacts(contacts)),
    );
    sock.ev.on(
      'contacts.update',
      guard((contacts) => this.#handleContacts(contacts)),
    );
    sock.ev.on(
      'groups.upsert',
      guard((groups) => this.#handleGroups(groups)),
    );
    sock.ev.on(
      'groups.update',
      guard((groups) => this.#handleGroups(groups)),
    );
    sock.ev.on(
      'messaging-history.set',
      guard((payload) => this.#handleHistory(payload)),
    );
  }

  async #handleConnectionUpdate(update) {
    if (update.qr) await this.#handleQr(update.qr);

    switch (update.connection) {
      case 'open':
        this.#handleOpen();
        break;
      case 'close':
        await this.#handleClose(update.lastDisconnect);
        break;
      default:
        break;
    }
  }

  async #handleQr(qr) {
    if (this.status !== 'pairing') {
      this.status = 'pairing';
      this.emitConnection();
    }

    let dataUrl;
    try {
      dataUrl = await this.qrEncoder(qr);
    } catch (err) {
      this.logger?.warn({ err }, 'could not render QR code');
      dataUrl = null;
    }

    this.pairing = {
      method: this.pairingMethod ?? 'qr',
      qr: dataUrl,
      qr_data: qr,
      code: this.pairing?.code ?? null,
      phone: this.pairingMethod === 'phone' ? this.phone : null,
      error: null,
      updated_at: new Date().toISOString(),
    };
    this.emit('pairing', this.pairing);
    this.#notifyPairingWaiters();

    if (
      this.pairingMethod === 'phone' &&
      this.phone &&
      !this.pairingCodeRequested &&
      this.sock
    ) {
      this.pairingCodeRequested = true;
      try {
        const raw = await this.sock.requestPairingCode(this.phone);
        this.pairing = {
          ...this.pairing,
          code: formatPairingCode(raw),
          error: null,
          updated_at: new Date().toISOString(),
        };
        this.logger?.info('requested a phone pairing code');
      } catch (err) {
        this.pairingCodeRequested = false;
        this.pairing = {
          ...this.pairing,
          error: `Could not request a pairing code: ${err.message}`,
          updated_at: new Date().toISOString(),
        };
        this.logger?.warn({ err }, 'could not request pairing code');
      }
      this.emit('pairing', this.pairing);
      this.#notifyPairingWaiters();
    }
  }

  #handleOpen() {
    this.#clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.status = 'connected';
    const user = this.sock?.user ?? this.creds?.me;
    this.me = this.#normalizeMe(user);
    this.connectedAt = new Date().toISOString();
    this.lastError = null;

    const wasPairing = Boolean(this.pairing);
    this.pairing = null;
    this.pairingMethod = null;
    this.phone = null;
    this.pairingCodeRequested = false;

    this.logger?.info({ me: this.me?.id }, 'connected to WhatsApp');
    this.emitConnection();
    if (wasPairing) {
      this.emit('pairing', {
        method: 'done',
        qr: null,
        code: null,
        done: true,
        updated_at: new Date().toISOString(),
      });
    }
    this.#notifyPairingWaiters();
    this.emitUnreadNow();
    this.#persist();
  }

  async #handleClose(lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message ?? 'connection closed';

    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end?.(undefined);
    } catch {
      // ignore
    }
    this.connectedAt = null;

    if (statusCode === this.deps.DisconnectReason.loggedOut) {
      this.logger?.warn('device was logged out; clearing the stored session');
      await this.#clearAuth();
      this.creds = null;
      this.me = null;
      this.pairing = null;
      this.status = 'logged_out';
      this.lastError =
        'This device was logged out on the phone. Pair it again to continue.';
      this.tracker.clear();
      this.emitConnection();
      this.emitUnreadNow();
      this.#persist();
      return;
    }

    if (statusCode === this.deps.DisconnectReason.connectionReplaced) {
      this.status = 'disconnected';
      this.lastError =
        'Another WhatsApp Web/Desktop session replaced this connection.';
      this.emitConnection();
      return;
    }

    this.status = 'connecting';
    this.lastError = reason;
    this.emitConnection();

    const delay =
      statusCode === this.deps.DisconnectReason.restartRequired
        ? 0
        : undefined;
    this.#scheduleReconnect(delay);
  }

  #scheduleReconnect(delay) {
    if (this.stopping || this.status === 'logged_out') return;
    this.#clearReconnectTimer();
    const wait =
      delay ??
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.logger?.info({ wait }, 'reconnecting to WhatsApp');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect().catch((err) => {
        this.lastError = err.message;
        this.emitConnection();
        this.#scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  async #handleMessagesUpsert({ messages = [], type } = {}) {
    const live = type === 'notify';

    for (const raw of messages) {
      if (!raw?.key?.remoteJid) continue;
      const chatName = this.tracker.nameFor(raw.key.remoteJid);
      const message = normalizeMessage(raw, {
        meId: this.me?.id,
        chatName,
        contentNormalizer: this.deps.normalizeMessageContent,
      });
      if (!message) continue;

      this.tracker.noteMessage(message, { countUnread: live });
      if (
        live &&
        message.eventWorthy &&
        this.#markEventSeen(message.chatId, message.messageId)
      ) {
        this.emit(
          'message',
          toPublicMessage(message, {
            chatName:
              this.tracker.nameFor(message.chatId) ?? message.chatName ?? null,
            receivedAt: new Date().toISOString(),
            unreadTotal: this.tracker.total(),
          }),
        );
      }
    }

    this.#scheduleUnread();
    this.#persist();
  }

  #markEventSeen(chatId, messageId) {
    if (!messageId) return true;
    const key = `${chatId}:${messageId}`;
    if (this.recentEventIds.includes(key)) return false;
    this.recentEventIds.push(key);
    if (this.recentEventIds.length > 300) this.recentEventIds.shift();
    return true;
  }

  #handleChats(chats, { seed }) {
    if (!Array.isArray(chats)) return;
    let changed = false;
    for (const chat of chats) {
      if (this.tracker.applyChat(chat, { seed })) changed = true;
    }
    if (changed) {
      this.#scheduleUnread();
      this.#persist();
    }
  }

  #handleContacts(contacts) {
    if (!Array.isArray(contacts)) return;
    let changed = false;
    for (const contact of contacts) {
      if (!contact?.id) continue;
      if (this.tracker.applyContact(contact.id, contact.name ?? contact.notify)) {
        changed = true;
      }
    }
    if (changed) {
      this.#scheduleUnread();
      this.#persist();
    }
  }

  #handleGroups(groups) {
    if (!Array.isArray(groups)) return;
    let changed = false;
    for (const group of groups) {
      if (!group?.id) continue;
      this.groupCache.set(group.id, group);
      if (this.tracker.applyGroup(group.id, group.subject)) changed = true;
    }
    if (changed) {
      this.#scheduleUnread();
      this.#persist();
    }
  }

  #handleHistory(payload) {
    const { chats = [], contacts = [] } = payload ?? {};
    let changed = false;
    for (const chat of chats) {
      if (this.tracker.applyChat(chat, { seed: true })) changed = true;
    }
    for (const contact of contacts) {
      if (contact?.id && this.tracker.applyContact(contact.id, contact.name)) {
        changed = true;
      }
    }
    if (changed) {
      this.#scheduleUnread();
      this.#persist();
    }
  }

  #normalizeMe(user) {
    if (!user?.id) return null;
    const id = normalizeJidUser(user.id);
    return {
      id,
      name: user.name ?? user.verifiedName ?? null,
      phone: jidToPhone(id),
      lid: user.lid ?? null,
    };
  }

  #scheduleUnread() {
    if (this.unreadTimer) return;
    this.unreadTimer = setTimeout(() => {
      this.unreadTimer = null;
      this.emitUnreadNow();
    }, UNREAD_DEBOUNCE_MS);
    this.unreadTimer.unref?.();
  }

  #clearUnreadTimer() {
    if (this.unreadTimer) {
      clearTimeout(this.unreadTimer);
      this.unreadTimer = null;
    }
  }

  emitUnreadNow() {
    this.emit('unread', this.tracker.unreadSnapshot());
  }

  #persist() {
    this.store.save(this.tracker.toJSON());
  }

  emitConnection() {
    this.emit('connection', {
      status: this.status,
      me: this.me,
      last_error: this.lastError,
      connected_at: this.connectedAt,
    });
  }

  async #waitForPairing(timeoutMs) {
    const ready = () => {
      if (this.status === 'connected') return true;
      if (this.pairing?.error) return true;
      if (this.pairingMethod === 'phone') return Boolean(this.pairing?.code);
      return Boolean(this.pairing?.qr);
    };
    if (ready()) return;

    return new Promise((resolve, reject) => {
      const check = () => {
        if (!ready()) return;
        clearTimeout(timer);
        this.pairingWaiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.pairingWaiters.delete(check);
        if (this.pairing?.error) {
          reject(
            new BridgeError(this.pairing.error, {
              status: 502,
              code: 'pairing_failed',
            }),
          );
        } else {
          reject(new PairingTimeoutError());
        }
      }, timeoutMs);
      timer.unref?.();
      this.pairingWaiters.add(check);
    });
  }

  #notifyPairingWaiters() {
    for (const check of [...this.pairingWaiters]) check();
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async #clearAuth() {
    await fsp.rm(this.authDir, { recursive: true, force: true });
    await fsp.mkdir(this.authDir, { recursive: true });
  }

  async close() {
    await this.stop();
    await this.store.close();
  }
}
