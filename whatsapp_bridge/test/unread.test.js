import assert from 'node:assert/strict';
import test from 'node:test';

import { UnreadTracker } from '../src/unread.js';

const ALICE = '15550001111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

test('seeds unread values from history and chat upserts', () => {
  const tracker = new UnreadTracker();
  assert.equal(
    tracker.applyChat(
      { id: ALICE, unreadCount: 3, conversationTimestamp: 100 },
      { seed: true },
    ),
    true,
  );
  assert.equal(tracker.total(), 3);
  assert.deepEqual(tracker.unreadSnapshot(), {
    total: 3,
    chats: [
      {
        id: ALICE,
        name: 'unknown',
        is_group: false,
        unread: 3,
        timestamp: 100,
      },
    ],
  });
});

test('ignores non-countable chats and null sentinels', () => {
  const tracker = new UnreadTracker();
  tracker.applyChat({ id: ALICE, unreadCount: 2 }, { seed: true });
  tracker.applyChat({ id: ALICE, unreadCount: null });
  assert.equal(tracker.total(), 2);

  tracker.applyChat({ id: 'status@broadcast', unreadCount: 9 }, { seed: true });
  tracker.applyChat({ id: '123@newsletter', unreadCount: 9 }, { seed: true });
  tracker.applyChat({ id: '456@broadcast', unreadCount: 9 }, { seed: true });
  assert.equal(tracker.total(), 2);
});

test('uses chat updates for read and unread transitions', () => {
  const tracker = new UnreadTracker();
  tracker.applyChat({ id: ALICE, unreadCount: 4 }, { seed: true });

  // A positive chats.update is a delta (handled by noteMessage), not a reset.
  tracker.applyChat({ id: ALICE, unreadCount: 1 });
  assert.equal(tracker.total(), 4);

  tracker.applyChat({ id: ALICE, unreadCount: 0 });
  assert.equal(tracker.total(), 0);

  tracker.applyChat({ id: ALICE, unreadCount: -1 });
  assert.equal(tracker.total(), 1);
});

test('counts live incoming messages and ignores noise', () => {
  const tracker = new UnreadTracker();
  const note = (message, options) => tracker.noteMessage(message, options);
  const base = {
    chatId: ALICE,
    messageId: 'm1',
    text: 'hi',
    type: 'text',
    timestamp: 10,
    fromMe: false,
    isGroup: false,
  };

  note(base, { countUnread: true });
  note({ ...base, messageId: 'm1' }, { countUnread: true });
  assert.equal(tracker.total(), 1);

  note({ ...base, messageId: 'm2', fromMe: true }, { countUnread: true });
  note({ ...base, messageId: 'm3', type: 'reaction' }, { countUnread: true });
  note({ ...base, messageId: 'm6', type: 'unknown' }, { countUnread: true });
  note({ ...base, messageId: 'm4' }, { countUnread: false });
  assert.equal(tracker.total(), 1);

  note({ ...base, messageId: 'm5' }, { countUnread: true });
  assert.equal(tracker.total(), 2);
});

test('history seeding raises but never lowers the counter', () => {
  const tracker = new UnreadTracker();
  tracker.applyChat({ id: ALICE, unreadCount: 1 }, { seed: true });
  tracker.applyChat({ id: ALICE, unreadCount: 8 }, { seed: true });
  assert.equal(tracker.total(), 8);

  tracker.applyChat({ id: ALICE, unreadCount: 3 }, { seed: true });
  assert.equal(tracker.total(), 8);

  tracker.applyChat({ id: GROUP, unreadCount: 4 }, { seed: true });
  assert.equal(tracker.total(), 12);
  assert.equal(tracker.nameFor(GROUP), null);
});

test('tracks the last message without changing the counter', () => {
  const tracker = new UnreadTracker();
  tracker.noteMessage({
    chatId: ALICE,
    chatName: 'Alice',
    messageId: 'm1',
    text: 'hello there',
    type: 'text',
    timestamp: 200,
    fromMe: false,
    senderId: ALICE,
    senderName: 'Alice',
    isGroup: false,
  });
  assert.equal(tracker.total(), 0);
  assert.equal(tracker.nameFor(ALICE), 'Alice');
  const [chat] = tracker.snapshot();
  assert.equal(chat.last_message.text, 'hello there');
  assert.equal(chat.timestamp, 200);
});

test('marking read clears unread and returns tracked keys', () => {
  const tracker = new UnreadTracker();
  tracker.applyChat({ id: GROUP, unreadCount: 2 }, { seed: true });
  tracker.noteMessage({
    chatId: GROUP,
    messageId: 'g1',
    text: 'yo',
    type: 'text',
    timestamp: 300,
    fromMe: false,
    senderId: '15550002222@s.whatsapp.net',
    isGroup: true,
  });

  assert.deepEqual(tracker.recentKeys(GROUP), [
    {
      remoteJid: GROUP,
      id: 'g1',
      participant: '15550002222@s.whatsapp.net',
    },
  ]);
  assert.equal(tracker.markRead(GROUP), true);
  assert.equal(tracker.total(), 0);
  assert.deepEqual(tracker.recentKeys(GROUP), []);
});

test('deduplicates recently seen message keys', () => {
  const tracker = new UnreadTracker({ maxRecentKeys: 2 });
  for (const id of ['a', 'b', 'a', 'c']) {
    tracker.noteMessage({
      chatId: ALICE,
      messageId: id,
      text: id,
      type: 'text',
      timestamp: 10,
      fromMe: false,
      isGroup: false,
    });
  }
  assert.deepEqual(
    tracker.recentKeys(ALICE).map((key) => key.id),
    ['c', 'a'],
  );
});

test('round-trips through JSON', () => {
  const tracker = new UnreadTracker();
  tracker.applyChat({ id: ALICE, unreadCount: 4, name: 'Alice' }, { seed: true });
  tracker.noteMessage({
    chatId: ALICE,
    messageId: 'm1',
    text: 'hi',
    type: 'text',
    timestamp: 50,
    fromMe: false,
    isGroup: false,
  });

  const restored = new UnreadTracker();
  restored.load(JSON.parse(JSON.stringify(tracker.toJSON())));
  assert.equal(restored.total(), 4);
  assert.equal(restored.nameFor(ALICE), 'Alice');
  assert.equal(restored.snapshot()[0].last_message.text, 'hi');
  assert.equal(restored.recentKeys(ALICE)[0].id, 'm1');
});

test('group and contact names are applied', () => {
  const tracker = new UnreadTracker();
  tracker.applyGroup(GROUP, 'Family');
  tracker.applyContact(ALICE, 'Alice');
  assert.equal(tracker.nameFor(GROUP), 'Family');
  assert.equal(tracker.nameFor(ALICE), 'Alice');
});

test('collapses LID and PN aliases for unread and read state', () => {
  const lid = '999999999999999@lid';
  const tracker = new UnreadTracker();

  tracker.noteMessage(
    {
      chatId: lid,
      messageId: 'm1',
      text: 'hello',
      type: 'text',
      timestamp: 10,
      fromMe: false,
      senderId: lid,
      senderName: 'Alice',
      isGroup: false,
    },
    { countUnread: true },
  );
  assert.equal(tracker.total(), 1);
  assert.equal(tracker.snapshot()[0].id, lid);

  tracker.registerAlias(lid, ALICE);
  assert.equal(tracker.total(), 1);
  assert.equal(tracker.snapshot()[0].id, ALICE);
  assert.equal(tracker.nameFor(lid), 'Alice');

  tracker.markRead(lid);
  assert.equal(tracker.total(), 0);
});

test('uses a contact username when no display name exists', () => {
  const tracker = new UnreadTracker();
  tracker.applyContact({
    id: ALICE,
    username: 'alice.w',
  });
  assert.equal(tracker.nameFor(ALICE), 'alice.w');
  assert.equal(tracker.usernameFor(ALICE), 'alice.w');
});

test('a read receipt can clear a chat by message id without an alias', () => {
  const lid = '999999999999999@lid';
  const tracker = new UnreadTracker();

  tracker.noteMessage(
    {
      chatId: lid,
      messageId: 'm-alias',
      text: 'hello',
      type: 'text',
      timestamp: 10,
      fromMe: false,
      isGroup: false,
    },
    { countUnread: true },
  );
  assert.equal(tracker.total(), 1);

  // The read receipt arrives under a different JID before the alias is known.
  tracker.markReadByMessageId('m-alias', ALICE);
  assert.equal(tracker.total(), 0);
});

test('a newer read on one alias wins when aliases merge', () => {
  const lid = '999999999999999@lid';
  const tracker = new UnreadTracker();

  // Unread chat stored under the phone-number JID.
  tracker.applyChat({ id: ALICE, unreadCount: 3 }, { seed: true });
  tracker.noteMessage({
    chatId: ALICE,
    messageId: 'old-1',
    text: 'old message',
    type: 'text',
    timestamp: 100,
    fromMe: false,
    isGroup: false,
  });

  // The phone reads the same conversation under the LID before the alias is
  // known to the bridge.
  tracker.applyChat({ id: lid, unreadCount: 0 });

  tracker.registerAlias(lid, ALICE);
  assert.equal(tracker.total(), 0);
});
