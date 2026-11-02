/**
 * Gmail folder counts and the message `total`.
 *
 * Per the Gmail API reference, `users.labels.list` returns only `id`, `name`,
 * `messageListVisibility`, `labelListVisibility` and `type` — it never carries message
 * counts. The counts live on the per-label resource and require `users.labels.get`.
 *
 * The previous implementation assumed the counts came back from `labels.list` for free,
 * so against a real mailbox every folder reported `unreadCount: 0, totalCount: 0` while
 * the inbox held unread mail. These tests pin the corrected behaviour:
 *
 *  - an exact count is fetched per label and reported;
 *  - the cheap path (`withUnreadCounts: false`) reports "not determined", never 0;
 *  - a failed or count-less lookup reports "not determined" with a reason;
 *  - `resultSizeEstimate` is never presented as a `total`.
 *
 * The Gmail client is replaced with a stub and token refresh is disabled, so nothing
 * here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleProvider } = require('@mcp-ecc/provider-google');

const UNKNOWN = -1;

function provider(gmail) {
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

/**
 * Stub both endpoints. `labels` is the labels.list payload — the real shape, i.e. with no
 * count fields. `counts` supplies what labels.get returns for a given id.
 */
function gmailStub({ labels = [], counts = {}, failFor = [], omitCountsFor = [] } = {}) {
  const calls = { list: 0, get: [] };
  return {
    calls,
    users: {
      labels: {
        list: async () => {
          calls.list += 1;
          return { data: { labels } };
        },
        get: async ({ id }) => {
          calls.get.push(id);
          if (failFor.includes(id)) throw new Error('backend error 500');
          if (omitCountsFor.includes(id)) return { data: { id, name: id, type: 'system' } };
          const c = counts[id] || { messagesUnread: 0, messagesTotal: 0 };
          return { data: { id, name: id, type: 'system', ...c } };
        },
      },
    },
  };
}

const byId = (folders, id) => folders.find((f) => f.id === id);

/* --------------------------- folder counts ---------------------------- */

test('google: counts come from labels.get, because labels.list never carries them', async () => {
  const gmail = gmailStub({
    // Exactly what the API returns: no messagesTotal / messagesUnread.
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
    ],
    counts: {
      INBOX: { messagesUnread: 17, messagesTotal: 412 },
      SENT: { messagesUnread: 0, messagesTotal: 90 },
    },
  });

  const folders = await provider(gmail).listFolders();

  assert.equal(gmail.calls.list, 1, 'the label listing is a single request');
  assert.ok(gmail.calls.get.includes('INBOX'), 'counts require a per-label lookup');

  const inbox = byId(folders, 'INBOX');
  assert.equal(inbox.unreadCount, 17);
  assert.equal(inbox.totalCount, 412);
  assert.equal(inbox.unreadCountError, undefined);

  // A real zero is still a zero — the fix must not mark everything unknown.
  const sent = byId(folders, 'SENT');
  assert.equal(sent.unreadCount, 0);
  assert.equal(sent.totalCount, 90);
  assert.equal(sent.unreadCountError, undefined);
});

test('google: withUnreadCounts: false spends no per-label lookups and reports unknown', async () => {
  const gmail = gmailStub({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });

  const folders = await provider(gmail).listFolders({ withUnreadCounts: false });

  assert.equal(gmail.calls.list, 1);
  assert.equal(gmail.calls.get.length, 0, 'the cheap path must not spend a request per folder');
  assert.ok(folders.length > 0);
  for (const folder of folders) {
    assert.equal(folder.unreadCount, UNKNOWN, `${folder.id} must be unknown, not 0`);
    assert.equal(folder.totalCount, UNKNOWN);
    assert.match(folder.unreadCountError, /not requested/);
  }
});

test('google: a failing per-label lookup is unknown and does not fail the listing', async () => {
  const gmail = gmailStub({
    labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
    counts: { INBOX: { messagesUnread: 4, messagesTotal: 40 } },
    failFor: ['SENT'],
  });

  const folders = await provider(gmail).listFolders();

  const sent = byId(folders, 'SENT');
  assert.equal(sent.unreadCount, UNKNOWN);
  assert.equal(sent.totalCount, UNKNOWN);
  assert.match(sent.unreadCountError, /labels\.get failed/);

  // Everything else is unaffected.
  assert.equal(byId(folders, 'INBOX').unreadCount, 4);
});

test('google: a lookup that returns no count fields is unknown with a reason', async () => {
  const gmail = gmailStub({
    labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
    omitCountsFor: ['INBOX'],
  });

  const inbox = byId(await provider(gmail).listFolders(), 'INBOX');
  assert.equal(inbox.unreadCount, UNKNOWN);
  assert.equal(inbox.totalCount, UNKNOWN);
  assert.match(inbox.unreadCountError, /no message counts/);
});

test('google: custom labels are surfaced and counted', async () => {
  const gmail = gmailStub({
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_9', name: 'Projects', type: 'user' },
    ],
    counts: { Label_9: { messagesUnread: 2, messagesTotal: 6 } },
  });

  const custom = byId(await provider(gmail).listFolders(), 'Label_9');
  assert.ok(custom, 'a user label is surfaced as a folder');
  assert.equal(custom.type, 'custom');
  assert.equal(custom.name, 'Projects');
  assert.equal(custom.unreadCount, 2);
  assert.equal(custom.totalCount, 6);
});

test('google: filtering to one folder costs a single count lookup', async () => {
  const gmail = gmailStub({
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
    ],
    counts: { INBOX: { messagesUnread: 3, messagesTotal: 30 } },
  });

  const folders = await provider(gmail).listFolders({ folderId: 'INBOX' });

  assert.deepEqual(folders.map((f) => f.id), ['INBOX']);
  assert.equal(folders[0].unreadCount, 3);
  assert.deepEqual(gmail.calls.get, ['INBOX'], 'only the requested folder is counted');
});

/* ------------------------ the message `total` ------------------------- */

test('google: resultSizeEstimate is never reported as a total', async () => {
  // Gmail returns the same estimate for mailboxes of very different sizes, so this
  // number means nothing as a count.
  const p = provider({
    users: { messages: { list: async () => ({ data: { resultSizeEstimate: 201, messages: [] } }) } },
  });

  const page = await p.listMessages('INBOX', { limit: 50 });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, undefined, 'an estimate must not be passed off as a total');
});

test('google: an empty result carries no total either', async () => {
  const p = provider({
    users: { messages: { list: async () => ({ data: { resultSizeEstimate: 201 } }) } },
  });

  const page = await p.listMessages('INBOX', { limit: 50 });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.total, undefined);
});
