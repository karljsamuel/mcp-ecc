/**
 * Gmail folder counts and the message `total`.
 *
 * Two defects are covered here, both observed against production:
 *
 *  1. `mail_listFolders` reported `unreadCount: 0, totalCount: 0` for every folder on
 *     two different accounts, while those folders demonstrably held mail. A label that
 *     comes back from labels.list without its count fields was being coerced to 0 —
 *     claiming the folder was empty.
 *
 *  2. `mail_listMessages` reported `total: 201` for both accounts. That was Gmail's
 *     `resultSizeEstimate`, which is an estimate and returns the same round number for
 *     mailboxes of very different sizes, so it must not be presented as a count.
 *
 * The Gmail client is replaced with a stub, and token refresh is disabled, so nothing
 * here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleProvider } = require('@mcp-ecc/provider-google');

const UNKNOWN = -1;

function provider(t, gmail) {
  const p = new GoogleProvider('acct-1', {
    accessToken: 'access-fixture',
    refreshToken: 'refresh-fixture',
    expiryDate: Date.now() + 3600_000,
    config: { email: 'owner@example.test' },
  });
  // Privately declared, but ordinary own-properties at runtime.
  p.ensureFreshToken = async () => {};
  p.gmail = gmail;
  return p;
}

function labelsApi(labels) {
  return { users: { labels: { list: async () => ({ data: { labels } }) } } };
}

/* --------------------------- folder counts ---------------------------- */

test('google: exact counts are reported when Gmail supplies them', async (t) => {
  const p = provider(t, labelsApi([
    { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 412, messagesUnread: 17 },
    { id: 'SENT', name: 'SENT', type: 'system', messagesTotal: 90, messagesUnread: 0 },
  ]));

  const folders = await p.listFolders();
  const inbox = folders.find((f) => f.id === 'INBOX');
  const sent = folders.find((f) => f.id === 'SENT');

  assert.equal(inbox.unreadCount, 17);
  assert.equal(inbox.totalCount, 412);
  assert.equal(inbox.unreadCountError, undefined);

  // A real zero is still reported as a zero — the fix must not over-correct.
  assert.equal(sent.unreadCount, 0);
  assert.equal(sent.totalCount, 90);
  assert.equal(sent.unreadCountError, undefined);
});

test('google: a label without count fields is unknown, never zero', async (t) => {
  // This is the production shape: the label exists, the counts do not.
  const p = provider(t, labelsApi([
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
  ]));

  const folders = await p.listFolders();
  const inbox = folders.find((f) => f.id === 'INBOX');

  assert.equal(inbox.unreadCount, UNKNOWN, 'absent unread count must not be reported as 0');
  assert.equal(inbox.totalCount, UNKNOWN, 'absent total must not be reported as 0');
  assert.match(inbox.unreadCountError, /no message counts/);
});

test('google: partly-counted labels keep the value they do have', async (t) => {
  const p = provider(t, labelsApi([
    { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 5 },
  ]));

  const inbox = (await p.listFolders()).find((f) => f.id === 'INBOX');
  assert.equal(inbox.unreadCount, 5, 'the count that was supplied is kept');
  assert.equal(inbox.totalCount, UNKNOWN, 'only the missing one is unknown');
  assert.match(inbox.unreadCountError, /no message counts/);
});

test('google: a label missing from labels.list is still unknown and explains why', async (t) => {
  const p = provider(t, labelsApi([]));

  const inbox = (await p.listFolders()).find((f) => f.id === 'INBOX');
  assert.equal(inbox.unreadCount, UNKNOWN);
  assert.equal(inbox.totalCount, UNKNOWN);
  assert.match(inbox.unreadCountError, /label missing/);
});

test('google: custom labels carry their counts and are not treated as system', async (t) => {
  const p = provider(t, labelsApi([
    { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 10, messagesUnread: 1 },
    { id: 'Label_9', name: 'Projects', type: 'user', messagesTotal: 6, messagesUnread: 2 },
  ]));

  const custom = (await p.listFolders()).find((f) => f.id === 'Label_9');
  assert.ok(custom, 'a user label is surfaced as a folder');
  assert.equal(custom.type, 'custom');
  assert.equal(custom.unreadCount, 2);
  assert.equal(custom.totalCount, 6);
});

/* ------------------------ the message `total` ------------------------- */

test('google: resultSizeEstimate is never reported as a total', async (t) => {
  // Gmail returns the same estimate for mailboxes of wildly different sizes, so this
  // number means nothing as a count.
  const p = provider(t, {
    users: {
      messages: {
        list: async () => ({ data: { resultSizeEstimate: 201, messages: [] } }),
      },
    },
  });

  const page = await p.listMessages('INBOX', { limit: 50 });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, undefined, 'an estimate must not be passed off as a total');
});

test('google: an empty result carries no total either', async (t) => {
  const p = provider(t, {
    users: {
      messages: {
        // No `messages` key at all — the other return path.
        list: async () => ({ data: { resultSizeEstimate: 201 } }),
      },
    },
  });

  const page = await p.listMessages('INBOX', { limit: 50 });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.total, undefined);
});
