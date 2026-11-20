import {
  isCountableChat,
  isGroupJid,
  toSeconds,
  truncate,
} from './util.js';

/**
 * Tracks per-chat unread counters and the last message seen in each chat.
 *
 * Baileys is not a chat store, so its `unreadCount` values have two different
 * meanings:
 *
 * - `chats.update` from a new message carries a *delta* (normally 1), not the
 *   absolute badge. Adding it to a base count would be correct, but treating
 *   it as absolute (a tempting mistake) resets the badge on every message.
 * - History sync and app-state sync carry absolute values: `unreadCount: 0`
 *   means "read on some device", `-1` means "mark as unread", and a positive
 *   value from `messaging-history.set` is the phone's real badge.
 *
 * The bridge therefore counts live incoming messages itself (deduplicated by
 * message ID), seeds the badge from history on first link, and uses chat
 * updates for read/unread transitions only. This is predictable and keeps the
 * count in sync when a chat is read on the phone.
 */
export class UnreadTracker {
  constructor({ maxChats = 500, maxRecentKeys = 30 } = {}) {
    this.maxChats = maxChats;
    this.maxRecentKeys = maxRecentKeys;
    this.chats = new Map();
    this.contactNames = new Map();
  }

  #ensure(id) {
    let chat = this.chats.get(id);
    if (!chat) {
      chat = {
        id,
        name: null,
        isGroup: isGroupJid(id),
        unread: 0,
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
    return this.chats.get(id)?.name ?? this.contactNames.get(id) ?? null;
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
    const id = update.id;
    const chat = this.#ensure(id);
    let changed = false;

    const name = update.name || update.subject || update.displayName;
    if (typeof name === 'string' && name.trim() && name !== chat.name) {
      chat.name = truncate(name.trim(), 120);
      changed = true;
    } else if (!chat.name) {
      const preferred = this.contactNames.get(id);
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
    const chat = this.#ensure(message.chatId);
    const ts = toSeconds(message.timestamp);

    if (!chat.name && !message.isGroup && message.chatName) {
      chat.name = truncate(message.chatName, 120);
    }
    if (!chat.name && message.isGroup && message.chatName) {
      chat.name = truncate(message.chatName, 120);
    }
    if (!chat.name && !message.isGroup && !message.fromMe && message.senderName) {
      chat.name = truncate(message.senderName, 120);
    }
    if (!chat.name) {
      const preferred = this.contactNames.get(message.chatId);
      if (preferred) chat.name = preferred;
    }
    if (ts >= chat.timestamp) chat.timestamp = ts;

    chat.lastMessage = {
      id: message.messageId ?? null,
      text: truncate(message.text ?? '', 300),
      type: message.type ?? 'unknown',
      timestamp: ts,
      from_me: Boolean(message.fromMe),
      sender_name: truncate(message.senderName ?? '', 120) || null,
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
    const chat = this.chats.get(chatId);
    if (!chat) return false;
    const changed = chat.unread !== 0;
    chat.unread = 0;
    chat.recentKeys = [];
    chat.countedIds = [];
    return changed;
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
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return chat.recentKeys
      .filter((key) => key.id)
      .map((key) => ({
        remoteJid: chat.id,
        id: key.id,
        ...(key.participant ? { participant: key.participant } : {}),
      }));
  }

  applyContact(id, name) {
    if (!id || !isCountableChat(id) || !name) return false;
    this.contactNames.set(id, truncate(String(name).trim(), 120));
    if (this.contactNames.size > 2000) {
      const oldest = this.contactNames.keys().next().value;
      if (oldest) this.contactNames.delete(oldest);
    }
    const chat = this.chats.get(id);
    if (!chat || chat.name) return false;
    chat.name = truncate(String(name).trim(), 120);
    return true;
  }

  applyGroup(id, subject) {
    if (!id || !isCountableChat(id) || !subject) return false;
    const chat = this.#ensure(id);
    chat.isGroup = true;
    if (chat.name === subject) return false;
    chat.name = truncate(String(subject).trim(), 120);
    return true;
  }

  #publicChat(chat, { includeKeys = false } = {}) {
    const result = {
      id: chat.id,
      name: chat.name,
      is_group: chat.isGroup,
      unread: Math.max(0, chat.unread),
      timestamp: chat.timestamp || 0,
      last_message: chat.lastMessage
        ? {
            ...chat.lastMessage,
            sender_name: chat.lastMessage.sender_name || null,
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
  }

  toJSON() {
    return {
      version: 1,
      chats: [...this.chats.values()].map((chat) =>
        this.#publicChat(chat, { includeKeys: true }),
      ),
    };
  }

  load(data) {
    if (!data || !Array.isArray(data.chats)) return;
    this.chats.clear();
    for (const raw of data.chats) {
      if (!raw?.id || !isCountableChat(raw.id)) continue;
      this.chats.set(raw.id, {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : null,
        isGroup: raw.is_group ?? isGroupJid(raw.id),
        unread: Number.isFinite(raw.unread) ? Math.max(0, raw.unread) : 0,
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
