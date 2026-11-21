import {
  isCountableChat,
  isGroupJid,
  isPhoneLike,
  nowSeconds,
  toSeconds,
  truncate,
} from './util.js';

/**
 * Tracks per-chat unread counters, names and the last message seen.
 *
 * Baileys is not a chat store, so its `unreadCount` values have two different
 * meanings:
 *
 * - `chats.update` from a new message carries a *delta* (normally 1), not the
 *   absolute badge.
 * - History sync and app-state sync carry absolute values: `unreadCount: 0`
 *   means "read on some device", `-1` means "mark as unread", and a positive
 *   value from `messaging-history.set` is the phone's real badge.
 *
 * The bridge therefore counts live incoming messages itself (deduplicated by
 * message ID), seeds the badge from history, and uses chat updates for
 * read/unread transitions only.
 *
 * WhatsApp may address the same conversation as either a LID (`@lid`) or a
 * phone-number JID (`@s.whatsapp.net`). Aliases are collapsed onto the PN JID
 * so a read on the phone resets the same chat the message arrived in, and a
 * contact name found under one identifier is used for the other.
 */
export class UnreadTracker {
  constructor({ maxChats = 500, maxRecentKeys = 30 } = {}) {
    this.maxChats = maxChats;
    this.maxRecentKeys = maxRecentKeys;
    this.chats = new Map();
    this.contactNames = new Map();
    this.usernames = new Map();
    this.aliases = new Map();
  }

  canonical(id) {
    if (!id) return id;
    let current = id;
    for (let i = 0; i < 8; i += 1) {
      const next = this.aliases.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  #pickCanonical(a, b) {
    if (a.endsWith('@g.us') || b.endsWith('@g.us')) {
      return a.endsWith('@g.us') ? a : b;
    }
    const aPn = a.endsWith('@s.whatsapp.net');
    const bPn = b.endsWith('@s.whatsapp.net');
    if (aPn && !bPn) return a;
    if (bPn && !aPn) return b;
    return a;
  }

  /**
   * Register that two JIDs address the same conversation (LID and PN).
   * Existing chat state is merged onto the preferred identifier.
   */
  registerAlias(a, b) {
    if (!a || !b || a === b) return;
    if (!isCountableChat(a) || !isCountableChat(b)) return;

    const canonicalA = this.canonical(a);
    const canonicalB = this.canonical(b);
    if (canonicalA === canonicalB) return;

    const canonicalId = this.#pickCanonical(canonicalA, canonicalB);
    const mergedId = canonicalId === canonicalA ? canonicalB : canonicalA;

    for (const [id, target] of this.aliases) {
      if (target === mergedId) this.aliases.set(id, canonicalId);
    }
    this.aliases.set(mergedId, canonicalId);
    this.aliases.set(canonicalId, canonicalId);

    this.#mergeChats(mergedId, canonicalId);

    const mergedName = this.contactNames.get(mergedId);
    if (mergedName && !this.contactNames.get(canonicalId)) {
      this.contactNames.set(canonicalId, mergedName);
    }
    this.contactNames.delete(mergedId);

    const mergedUsername = this.usernames.get(mergedId);
    if (mergedUsername && !this.usernames.get(canonicalId)) {
      this.usernames.set(canonicalId, mergedUsername);
    }
    this.usernames.delete(mergedId);
  }

  registerAliasesFromKey(key) {
    if (!key) return;
    if (key.remoteJid && key.remoteJidAlt) {
      this.registerAlias(key.remoteJid, key.remoteJidAlt);
    }
    if (key.participant && key.participantAlt) {
      this.registerAlias(key.participant, key.participantAlt);
    }
  }

  #mergeChats(fromId, toId) {
    const from = this.chats.get(fromId);
    if (!from) return;
    const to = this.#ensure(toId);
    const fromReadAt = from.readAt || 0;
    const toReadAt = to.readAt || 0;
    const newerRead = fromReadAt > toReadAt ? from : to;
    const other = newerRead === from ? to : from;
    const otherLast = other.lastMessage?.timestamp || other.timestamp || 0;
    if ((newerRead.readAt || 0) > otherLast) {
      // One side was read after the other side's newest message, so its
      // (usually zero) counter is the current state.
      to.unread = newerRead.unread;
    } else {
      to.unread = Math.max(to.unread, from.unread);
    }
    to.readAt = Math.max(fromReadAt, toReadAt);
    to.isGroup = to.isGroup || from.isGroup;
    if (!to.name && from.name) to.name = from.name;
    if ((from.timestamp || 0) > (to.timestamp || 0)) {
      to.timestamp = from.timestamp;
      if (from.lastMessage) to.lastMessage = from.lastMessage;
    }
    const keys = [...to.recentKeys, ...from.recentKeys];
    const seen = new Set();
    to.recentKeys = keys
      .filter((key) => {
        if (!key?.id || seen.has(key.id)) return false;
        seen.add(key.id);
        return true;
      })
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, this.maxRecentKeys);
    to.countedIds = [
      ...new Set([...to.countedIds, ...from.countedIds]),
    ].slice(-200);
    this.chats.delete(fromId);
  }

  #ensure(id) {
    let chat = this.chats.get(id);
    if (!chat) {
      chat = {
        id,
        name: null,
        isGroup: isGroupJid(id),
        unread: 0,
        readAt: 0,
        timestamp: 0,
        lastMessage: null,
        recentKeys: [],
        countedIds: [],
      };
      this.chats.set(id, chat);
      this.#trim();
    }
    return chat;
  }

  #trim() {
    if (this.chats.size <= this.maxChats) return;
    const oldestFirst = [...this.chats.values()].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
    for (const chat of oldestFirst) {
      if (this.chats.size <= this.maxChats) break;
      if (chat.unread === 0 && !chat.lastMessage) this.chats.delete(chat.id);
    }
    for (const chat of oldestFirst) {
      if (this.chats.size <= this.maxChats) break;
      this.chats.delete(chat.id);
    }
  }

  nameFor(id) {
    const canonicalId = this.canonical(id);
    return (
      this.chats.get(canonicalId)?.name ??
      this.contactNames.get(canonicalId) ??
      this.usernames.get(canonicalId) ??
      null
    );
  }

  usernameFor(id) {
    return this.usernames.get(this.canonical(id)) ?? null;
  }

  total() {
    let total = 0;
    for (const chat of this.chats.values()) {
      if (isCountableChat(chat.id)) total += Math.max(0, chat.unread);
    }
    return total;
  }

  /**
   * Apply a Baileys Chat / ChatUpdate.
   * @param {object} update
   * @param {{seed?: boolean}} options `seed` treats a positive unreadCount as
   * an absolute badge (history sync / chat upsert) instead of a delta.
   * @returns {boolean} whether anything worth broadcasting changed
   */
  applyChat(update, { seed = false } = {}) {
    if (!update?.id || !isCountableChat(update.id)) return false;
    const id = this.canonical(update.id);
    const chat = this.#ensure(id);
    let changed = false;

    const name = update.name || update.subject || update.displayName;
    if (typeof name === 'string' && name.trim() && name !== chat.name) {
      chat.name = truncate(name.trim(), 120);
      changed = true;
    } else if (!chat.name) {
      const preferred = this.nameFor(id);
      if (preferred) {
        chat.name = preferred;
        changed = true;
      }
    }

    if (
      typeof update.unreadCount === 'number' &&
      Number.isFinite(update.unreadCount)
    ) {
      if (update.unreadCount === 0) {
        // Read on this device or on the phone (app-state sync).
        chat.readAt = nowSeconds();
        if (chat.unread !== 0) {
          chat.unread = 0;
          chat.countedIds = [];
          changed = true;
        }
      } else if (update.unreadCount < 0) {
        // Baileys uses -1 for "mark as unread"; there is no real count.
        if (chat.unread === 0) {
          chat.unread = 1;
          changed = true;
        }
      } else if (seed) {
        // A positive value from history/upsert is the phone's real badge. Use
        // the higher of the two so offline messages are picked up without
        // discarding messages already counted live.
        const next = Math.floor(update.unreadCount);
        if (next > chat.unread) {
          chat.unread = next;
          changed = true;
        }
      }
      // A positive value on a normal chats.update is a delta; it is ignored
      // here because noteMessage() has already counted the message.
    }

    const ts =
      toSeconds(update.conversationTimestamp) ||
      toSeconds(update.lastMessageRecvTimestamp);
    if (ts > chat.timestamp) {
      chat.timestamp = ts;
      changed = true;
    }

    if (changed) this.#trim();
    return changed;
  }

  /**
   * Record message metadata, remember the key so it can be marked read, and
   * count live incoming messages towards the unread badge.
   */
  noteMessage(message, { countUnread = false } = {}) {
    if (!message?.chatId || !isCountableChat(message.chatId)) return null;
    const chat = this.#ensure(this.canonical(message.chatId));
    const ts = toSeconds(message.timestamp);

    if (!chat.name && message.isGroup && message.chatName) {
      chat.name = truncate(message.chatName, 120);
    }
    if (!chat.name && !message.isGroup && message.chatName) {
      chat.name = truncate(message.chatName, 120);
    }
    if (!chat.name && !message.isGroup && !message.fromMe && message.senderName) {
      chat.name = truncate(message.senderName, 120);
    }
    if (!chat.name) {
      const preferred = this.nameFor(chat.id);
      if (preferred) chat.name = preferred;
    }
    if (ts >= chat.timestamp) chat.timestamp = ts;

    chat.lastMessage = {
      id: message.messageId ?? null,
      text: truncate(message.text ?? '', 300),
      type: message.type ?? 'unknown',
      timestamp: ts,
      from_me: Boolean(message.fromMe),
      sender_name: truncate(message.senderName || 'unknown', 120),
      sender_username: message.senderUsername ?? null,
      group_name: message.isGroup ? message.chatName || 'unknown' : null,
    };

    if (!message.fromMe && message.messageId) {
      const key = {
        id: message.messageId,
        participant: message.isGroup ? message.senderId ?? null : null,
        timestamp: ts,
      };
      chat.recentKeys = [
        key,
        ...chat.recentKeys.filter((existing) => existing.id !== key.id),
      ].slice(0, this.maxRecentKeys);

      const countable =
        countUnread &&
        message.eventWorthy !== false &&
        message.type !== 'reaction' &&
        message.type !== 'protocol' &&
        message.type !== 'unknown';
      if (countable && !chat.countedIds.includes(message.messageId)) {
        chat.countedIds.push(message.messageId);
        if (chat.countedIds.length > 200) chat.countedIds.shift();
        chat.unread += 1;
      }
    }

    return this.#publicChat(chat);
  }

  markRead(chatId) {
    const chat = this.chats.get(this.canonical(chatId));
    if (!chat) return false;
    const changed = chat.unread !== 0;
    chat.unread = 0;
    chat.readAt = nowSeconds();
    chat.recentKeys = [];
    chat.countedIds = [];
    return changed;
  }

  markReadByMessageId(messageId, chatId) {
    const preferred = this.chats.get(this.canonical(chatId));
    if (
      messageId &&
      preferred?.recentKeys.some((key) => key.id === messageId)
    ) {
      return this.markRead(preferred.id);
    }
    if (messageId) {
      for (const chat of this.chats.values()) {
        if (chat.recentKeys.some((key) => key.id === messageId)) {
          return this.markRead(chat.id);
        }
      }
    }
    return this.markRead(chatId);
  }

  markAllRead() {
    let changed = false;
    for (const chat of this.chats.values()) {
      if (chat.unread !== 0) changed = true;
      chat.unread = 0;
      chat.recentKeys = [];
      chat.countedIds = [];
    }
    return changed;
  }

  recentKeys(chatId) {
    const chat = this.chats.get(this.canonical(chatId));
    if (!chat) return [];
    return chat.recentKeys
      .filter((key) => key.id)
      .map((key) => ({
        remoteJid: chat.id,
        id: key.id,
        ...(key.participant ? { participant: key.participant } : {}),
      }));
  }

  applyContact(contactOrId, name) {
    const contact =
      typeof contactOrId === 'string'
        ? { id: contactOrId, name }
        : contactOrId;
    if (!contact) return false;

    const ids = [contact.id, contact.phoneNumber, contact.lid].filter(
      (value) => typeof value === 'string' && isCountableChat(value),
    );
    if (!ids.length) return false;

    for (const other of ids.slice(1)) {
      this.registerAlias(ids[0], other);
    }

    const id = this.canonical(ids[0]);
    const display = contact.name || contact.notify || contact.username;
    let changed = false;

    if (display) {
      this.contactNames.set(id, truncate(String(display).trim(), 120));
      if (this.contactNames.size > 2000) {
        const oldest = this.contactNames.keys().next().value;
        if (oldest) this.contactNames.delete(oldest);
      }
      const chat = this.chats.get(id);
      if (chat && !chat.name) {
        chat.name = truncate(String(display).trim(), 120);
        changed = true;
      }
    }
    if (contact.username) {
      this.usernames.set(id, truncate(String(contact.username).trim(), 120));
    }
    return changed;
  }

  applyGroup(id, subject) {
    if (!id || !isCountableChat(id) || !subject) return false;
    const chat = this.#ensure(this.canonical(id));
    chat.isGroup = true;
    if (chat.name === subject) return false;
    chat.name = truncate(String(subject).trim(), 120);
    return true;
  }

  #publicChat(chat, { includeKeys = false } = {}) {
    const displayName = this.nameFor(chat.id);
    const name =
      displayName && (chat.isGroup || !isPhoneLike(displayName))
        ? displayName
        : 'unknown';
    const result = {
      id: chat.id,
      name,
      is_group: chat.isGroup,
      unread: Math.max(0, chat.unread),
      timestamp: chat.timestamp || 0,
      read_at: chat.readAt || 0,
      last_message: chat.lastMessage
        ? {
            ...chat.lastMessage,
            sender_name: chat.lastMessage.sender_name || 'unknown',
          }
        : null,
    };
    if (includeKeys) result.recent_keys = chat.recentKeys;
    return result;
  }

  snapshot({ limit = 100, onlyUnread = false } = {}) {
    let chats = [...this.chats.values()].filter((chat) =>
      isCountableChat(chat.id),
    );
    if (onlyUnread) chats = chats.filter((chat) => chat.unread > 0);
    chats.sort((a, b) => {
      if (onlyUnread && b.unread !== a.unread) return b.unread - a.unread;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
    if (limit > 0) chats = chats.slice(0, limit);
    return chats.map((chat) => this.#publicChat(chat));
  }

  unreadSnapshot() {
    return {
      total: this.total(),
      chats: this.snapshot({ onlyUnread: true, limit: 50 }).map((chat) => ({
        id: chat.id,
        name: chat.name,
        is_group: chat.is_group,
        unread: chat.unread,
        timestamp: chat.timestamp,
      })),
    };
  }

  clear() {
    this.chats.clear();
    this.contactNames.clear();
    this.usernames.clear();
    this.aliases.clear();
  }

  toJSON() {
    return {
      version: 2,
      chats: [...this.chats.values()].map((chat) =>
        this.#publicChat(chat, { includeKeys: true }),
      ),
      aliases: [...this.aliases.entries()],
      usernames: [...this.usernames.entries()],
    };
  }

  load(data) {
    if (!data || !Array.isArray(data.chats)) return;
    this.chats.clear();
    this.aliases.clear();
    this.usernames.clear();
    this.contactNames.clear();

    for (const [id, target] of data.aliases ?? []) {
      if (typeof id === 'string' && typeof target === 'string') {
        this.aliases.set(id, target);
      }
    }
    for (const [id, username] of data.usernames ?? []) {
      if (typeof id === 'string' && typeof username === 'string') {
        this.usernames.set(this.canonical(id), username);
      }
    }

    for (const raw of data.chats) {
      if (!raw?.id || !isCountableChat(raw.id)) continue;
      const id = this.canonical(raw.id);
      this.chats.set(id, {
        id,
        name: typeof raw.name === 'string' ? raw.name : null,
        isGroup: raw.is_group ?? isGroupJid(id),
        unread: Number.isFinite(raw.unread) ? Math.max(0, raw.unread) : 0,
        readAt: Number.isFinite(raw.read_at) ? raw.read_at : 0,
        timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : 0,
        lastMessage: raw.last_message ?? null,
        recentKeys: Array.isArray(raw.recent_keys)
          ? raw.recent_keys.slice(0, this.maxRecentKeys)
          : [],
        countedIds: [],
      });
    }
    this.#trim();
  }
}
