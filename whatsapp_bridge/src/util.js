/** Small helpers shared across the bridge. */
import { timingSafeEqual } from 'node:crypto';

export const STATUS_JID = 'status@broadcast';

export function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  // protobufjs Long
  if (typeof value.toNumber === 'function') {
    try {
      return value.toNumber();
    } catch {
      return 0;
    }
  }
  if (typeof value.low === 'number') return value.low;
  return 0;
}

/** WhatsApp timestamps are normally seconds, but some paths hand out ms. */
export function toSeconds(value) {
  const n = toNumber(value);
  if (!n) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isStatusJid(jid) {
  return jid === STATUS_JID;
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
}

/**
 * Chats that should count towards the unread total. Status updates and
 * newsletters are noise for an unread badge, broadcast lists are one-way.
 */
export function isCountableChat(jid) {
  if (typeof jid !== 'string' || !jid) return false;
  if (isStatusJid(jid) || isNewsletterJid(jid)) return false;
  if (jid.endsWith('@broadcast')) return false;
  return true;
}

export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Phone number must contain 7-15 digits in international format');
  }
  return digits;
}

export function normalizeJidUser(jid) {
  if (typeof jid !== 'string') return jid;
  // 15551234567:12@s.whatsapp.net -> 15551234567@s.whatsapp.net
  return jid.replace(/^(\d+)(?::\d+)?@/, '$1@');
}

export function jidToPhone(jid) {
  if (typeof jid !== 'string') return null;
  const match = /^(\d+)/.exec(jid);
  return match ? match[1] : null;
}

export function truncate(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function formatPairingCode(code) {
  const clean = String(code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length === 8) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return clean;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
