import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessage, toPublicMessage } from '../src/message.js';

const ME = '15550000000@s.whatsapp.net';
const ALICE = '15550001111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

test('normalizes a direct text message', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: ALICE, fromMe: false, id: 'm1' },
      message: { conversation: 'hello' },
      messageTimestamp: 1700000000,
      pushName: 'Alice',
    },
    { meId: ME },
  );

  assert.equal(message.chatId, ALICE);
  assert.equal(message.type, 'text');
  assert.equal(message.text, 'hello');
  assert.equal(message.isGroup, false);
  assert.equal(message.fromMe, false);
  assert.equal(message.senderId, ALICE);
  assert.equal(message.timestamp, 1700000000);
  assert.equal(message.hasMedia, false);
  assert.equal(message.eventWorthy, true);
});

test('uses the participant as sender for groups', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: GROUP, fromMe: false, id: 'm2', participant: ALICE },
      message: { extendedTextMessage: { text: 'hi all' } },
      messageTimestamp: 1700000001,
      pushName: 'Alice',
    },
    { meId: ME, chatName: 'Family' },
  );

  assert.equal(message.isGroup, true);
  assert.equal(message.senderId, ALICE);
  assert.equal(toPublicMessage(message, { chatName: 'Family' }).chat_name, 'Family');
});

test('extracts captions and media metadata', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: ALICE, fromMe: false, id: 'm3' },
      message: {
        imageMessage: {
          caption: 'look at this',
          mimetype: 'image/jpeg',
          fileLength: 1234,
          width: 800,
          height: 600,
        },
      },
      messageTimestamp: 1700000002,
    },
    { meId: ME },
  );

  assert.equal(message.type, 'image');
  assert.equal(message.text, 'look at this');
  assert.equal(message.hasMedia, true);
  assert.equal(message.media.mimetype, 'image/jpeg');
  assert.equal(message.media.width, 800);
});

test('marks push-to-talk audio as a voice note', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: ALICE, fromMe: false, id: 'm4' },
      message: { audioMessage: { ptt: true, seconds: 12, mimetype: 'audio/ogg' } },
      messageTimestamp: 1700000003,
    },
    { meId: ME },
  );

  assert.equal(message.type, 'voice');
  assert.equal(message.media.is_voice_note, true);
  assert.equal(message.media.seconds, 12);
});

test('unwraps view-once and ephemeral containers', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: ALICE, fromMe: false, id: 'm5' },
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: { caption: 'secret', mimetype: 'image/jpeg' },
          },
        },
      },
      messageTimestamp: 1700000004,
    },
    { meId: ME },
  );

  assert.equal(message.type, 'image');
  assert.equal(message.text, 'secret');
});

test('skips system messages and flags protocol messages', () => {
  assert.equal(
    normalizeMessage(
      {
        key: { remoteJid: GROUP, fromMe: false, id: 's1' },
        messageStubType: 1,
        message: { conversation: 'Alice joined' },
      },
      { meId: ME },
    ),
    null,
  );

  const protocol = normalizeMessage(
    {
      key: { remoteJid: ALICE, fromMe: true, id: 'p1' },
      message: { protocolMessage: { type: 0 } },
      messageTimestamp: 1700000005,
    },
    { meId: ME },
  );
  assert.equal(protocol.type, 'protocol');
  assert.equal(protocol.eventWorthy, false);
});

test('keeps reaction text and quoted metadata', () => {
  const message = normalizeMessage(
    {
      key: { remoteJid: GROUP, fromMe: false, id: 'r1', participant: ALICE },
      message: {
        reactionMessage: {
          text: '👍',
          key: { id: 'm2' },
        },
      },
      messageTimestamp: 1700000006,
    },
    { meId: ME },
  );
  assert.equal(message.type, 'reaction');
  assert.equal(message.text, '👍');
});
