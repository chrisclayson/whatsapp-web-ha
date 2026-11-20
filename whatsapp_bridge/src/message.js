import { isGroupJid, toSeconds, truncate } from './util.js';

/** Message keys that map to a stable, user-facing type. */
const TYPE_BY_KEY = {
  conversation: 'text',
  extendedTextMessage: 'text',
  editedMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contacts',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  reactionMessage: 'reaction',
  eventMessage: 'event',
  groupInviteMessage: 'group_invite',
  buttonsResponseMessage: 'button',
  listResponseMessage: 'list',
  templateButtonReplyMessage: 'button',
  protocolMessage: 'protocol',
};

const MEDIA_TYPES = new Set([
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
]);

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
];

function unwrap(content) {
  let current = content;
  for (let i = 0; i < 5 && current; i += 1) {
    let next;
    for (const wrapper of WRAPPER_KEYS) {
      if (current[wrapper]?.message) {
        next = current[wrapper].message;
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
}

function detectType(content) {
  if (!content) return 'unknown';
  for (const key of Object.keys(TYPE_BY_KEY)) {
    if (content[key] !== undefined && content[key] !== null) {
      return TYPE_BY_KEY[key];
    }
  }
  return 'unknown';
}

function primaryNode(content, type) {
  switch (type) {
    case 'text':
      return content.extendedTextMessage ?? content.editedMessage?.message ?? null;
    case 'image':
      return content.imageMessage ?? null;
    case 'video':
      return content.videoMessage ?? null;
    case 'audio':
    case 'voice':
      return content.audioMessage ?? null;
    case 'document':
      return content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage ?? null;
    case 'sticker':
      return content.stickerMessage ?? null;
    case 'location':
      return content.locationMessage ?? content.liveLocationMessage ?? null;
    case 'contact':
      return content.contactMessage ?? null;
    case 'contacts':
      return content.contactsArrayMessage ?? null;
    case 'poll':
      return content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3 ?? null;
    case 'reaction':
      return content.reactionMessage ?? null;
    case 'event':
      return content.eventMessage ?? null;
    case 'group_invite':
      return content.groupInviteMessage ?? null;
    default:
      return null;
  }
}

function extractText(content, type, node) {
  switch (type) {
    case 'text':
      return (
        content.conversation ??
        content.extendedTextMessage?.text ??
        content.editedMessage?.message?.conversation ??
        content.editedMessage?.message?.extendedTextMessage?.text ??
        ''
      );
    case 'image':
      return node?.caption ?? '';
    case 'video':
      return node?.caption ?? '';
    case 'audio':
    case 'voice':
      return '';
    case 'document':
      return node?.caption || node?.fileName || '';
    case 'sticker':
      return '';
    case 'location':
      return node?.name || node?.address || 'Location';
    case 'contact':
      return node?.displayName ?? '';
    case 'contacts': {
      const first = node?.contacts?.[0];
      return first?.displayName ?? '';
    }
    case 'poll':
      return node?.name ?? '';
    case 'reaction':
      return node?.text ?? '';
    case 'event':
      return node?.name ?? '';
    case 'group_invite':
      return node?.caption || node?.groupName || '';
    case 'button':
      return (
        content.buttonsResponseMessage?.selectedDisplayText ??
        content.templateButtonReplyMessage?.selectedDisplayText ??
        ''
      );
    case 'list':
      return content.listResponseMessage?.title ?? '';
    default:
      return '';
  }
}

function extractMedia(type, node) {
  if (!MEDIA_TYPES.has(type) || !node) return null;
  const media = {};
  if (node.mimetype) media.mimetype = node.mimetype;
  if (node.fileLength !== undefined) media.file_length = Number(node.fileLength);
  if (node.seconds !== undefined) media.seconds = Number(node.seconds);
  if (node.fileName) media.file_name = node.fileName;
  if (node.pageCount !== undefined) media.page_count = Number(node.pageCount);
  if (node.width !== undefined) media.width = Number(node.width);
  if (node.height !== undefined) media.height = Number(node.height);
  if (node.isAnimated !== undefined) media.is_animated = Boolean(node.isAnimated);
  if (type === 'voice') media.is_voice_note = true;
  return Object.keys(media).length ? media : null;
}

function extractLocation(type, node) {
  if (type !== 'location' || !node) return null;
  return {
    latitude: node.degreesLatitude ?? null,
    longitude: node.degreesLongitude ?? null,
    name: node.name ?? null,
    address: node.address ?? null,
    is_live: Boolean(node.isLive),
  };
}

/**
 * Turn a raw Baileys WAMessage into a compact internal message object.
 * Returns null for messages that never belong in an automation (system
 * messages, missing keys).
 */
export function normalizeMessage(
  raw,
  { meId = null, chatName = null, contentNormalizer = (content) => content } = {},
) {
  const key = raw?.key;
  if (!key?.remoteJid) return null;
  if (raw.messageStubType) return null;

  let normalizedContent;
  try {
    normalizedContent = contentNormalizer(raw.message);
  } catch {
    normalizedContent = raw.message;
  }
  const content = unwrap(normalizedContent ?? raw.message);
  if (!content) return null;

  let type = detectType(content);
  if (content.audioMessage?.ptt) type = 'voice';

  if (type === 'protocol') {
    return {
      messageId: key.id ?? null,
      chatId: key.remoteJid,
      chatName,
      isGroup: isGroupJid(key.remoteJid),
      senderId: key.participant ?? (key.fromMe ? meId : key.remoteJid),
      senderName: raw.pushName ?? null,
      fromMe: Boolean(key.fromMe),
      type,
      text: '',
      timestamp: toSeconds(raw.messageTimestamp),
      hasMedia: false,
      media: null,
      location: null,
      mentions: [],
      quotedMessageId: null,
      isForwarded: false,
      eventWorthy: false,
    };
  }

  const node = primaryNode(content, type);
  const contextInfo =
    node?.contextInfo ??
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    null;

  const senderId =
    key.participant ??
    key.participantAlt ??
    (key.fromMe ? meId ?? key.remoteJid : key.remoteJid);

  return {
    messageId: key.id ?? null,
    chatId: key.remoteJid,
    chatName,
    isGroup: isGroupJid(key.remoteJid),
    senderId,
    senderName: raw.pushName ?? null,
    fromMe: Boolean(key.fromMe),
    type,
    text: truncate(String(extractText(content, type, node) ?? ''), 4000),
    timestamp: toSeconds(raw.messageTimestamp),
    hasMedia: MEDIA_TYPES.has(type),
    media: extractMedia(type, node),
    location: extractLocation(type, node),
    mentions: Array.isArray(contextInfo?.mentionedJid)
      ? contextInfo.mentionedJid
      : [],
    quotedMessageId: contextInfo?.stanzaId ?? null,
    isForwarded: Boolean(contextInfo?.isForwarded),
    eventWorthy: true,
  };
}

/** Wire format used by the HTTP API and the WebSocket stream. */
export function toPublicMessage(
  message,
  { chatName = null, receivedAt = null, unreadTotal = null } = {},
) {
  return {
    message_id: message.messageId,
    chat_id: message.chatId,
    chat_name: chatName ?? message.chatName ?? null,
    is_group: message.isGroup,
    sender_id: message.senderId,
    sender_name: message.senderName,
    from_me: message.fromMe,
    type: message.type,
    text: message.text,
    timestamp: message.timestamp,
    has_media: message.hasMedia,
    media: message.media,
    location: message.location,
    mentions: message.mentions,
    quoted_message_id: message.quotedMessageId,
    is_forwarded: message.isForwarded,
    received_at: receivedAt,
    unread_total: unreadTotal,
  };
}
