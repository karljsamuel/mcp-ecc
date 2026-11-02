/**
 * Sender identity and mailbox login resolution for the IMAP/SMTP provider.
 *
 * Both regressions covered here come from the same root cause: the internal account id
 * was used as the mailbox login and as the outbound From address. Accounts created in
 * the web UI have a random UUID as their id, so the login was rejected by the mail
 * server and outbound mail carried a UUID as its sender.
 *
 * nodemailer is stubbed before the provider is loaded so sendMessage can be observed
 * without an SMTP server; nothing here opens a network connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const sent = [];
const nodemailerStub = {
  createTransport: () => ({
    sendMail: async (options) => {
      sent.push(options);
      return { messageId: '<stub-message-id@example.com>' };
    },
    close: () => {},
  }),
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'nodemailer') return nodemailerStub;
  return originalLoad.call(this, request, ...rest);
};
const { ImapSmtpProvider } = require('../packages/providers/imap-smtp/dist/index.js');
Module._load = originalLoad;

// A realistic account id for one created through the management API.
const WEB_ACCOUNT_ID = '9f2c1d84-6b30-4a2e-9c11-7d5e8f0a1b23';
const MAILBOX = 'owner@example.com';

function credential(extra = {}) {
  return { appPassword: 'app-password-fixture', config: { ...extra } };
}

/* ------------------------------ mailbox login ------------------------- */

test('imap: the account email is the mailbox login, not the account id', () => {
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX }));
  assert.equal(provider.imapConfig.auth.user, MAILBOX);
  assert.equal(provider.smtpConfig.auth.user, MAILBOX);
});

test('imap: an explicit username wins over the account email', () => {
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX, username: 'login-name' }));
  assert.equal(provider.imapConfig.auth.user, 'login-name');
  assert.equal(provider.smtpConfig.auth.user, 'login-name');
});

test('imap: accounts whose id is the email address keep working', () => {
  // The CLI creates accounts with the email as their id, so the fallback must stay.
  const provider = new ImapSmtpProvider(MAILBOX, credential());
  assert.equal(provider.imapConfig.auth.user, MAILBOX);
  assert.equal(provider.smtpConfig.auth.user, MAILBOX);
});

test('imap: the app password is passed to both transports and is never empty', () => {
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX }));
  assert.equal(provider.imapConfig.auth.pass, 'app-password-fixture');
  assert.equal(provider.smtpConfig.auth.pass, 'app-password-fixture');
});

/* ------------------------------ sender identity ----------------------- */

test('imap: a display name becomes the From name alongside the mailbox address', async () => {
  sent.length = 0;
  const provider = new ImapSmtpProvider(
    WEB_ACCOUNT_ID,
    credential({ email: MAILBOX, displayName: 'Karl J Samuel' }),
  );

  const result = await provider.sendMessage({ to: [{ address: 'someone@example.com' }], subject: 'Hello', body: 'Body' });

  assert.deepEqual(sent[0].from, { name: 'Karl J Samuel', address: MAILBOX });
  assert.deepEqual(result.from, { name: 'Karl J Samuel', address: MAILBOX });
});

test('imap: without a display name the From is the bare mailbox address', async () => {
  sent.length = 0;
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX }));

  const result = await provider.sendMessage({ to: [{ address: 'someone@example.com' }], subject: 'Hello', body: 'Body' });

  assert.deepEqual(sent[0].from, { address: MAILBOX });
  assert.deepEqual(result.from, { address: MAILBOX });
});

test('imap: the internal account id is never used as a sender', async () => {
  sent.length = 0;
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX }));
  const result = await provider.sendMessage({ to: [{ address: 'someone@example.com' }], subject: 'Hello', body: 'Body' });

  assert.ok(!JSON.stringify(result.from).includes(WEB_ACCOUNT_ID), 'the From must not mention the account id');
  assert.ok(!JSON.stringify(sent[0]).includes(WEB_ACCOUNT_ID), 'the wire message must not mention the account id');
});

test('imap: sending with no resolvable address fails loudly instead of emitting a UUID', async () => {
  sent.length = 0;
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential());

  await assert.rejects(
    () => provider.sendMessage({ to: [{ address: 'someone@example.com' }], subject: 'Hello', body: 'Body' }),
    /no valid mailbox email address/,
  );
  assert.equal(sent.length, 0, 'nothing may be handed to the transport when the sender cannot be resolved');
});

test('imap: the returned message id comes from the transport, not a placeholder', async () => {
  const provider = new ImapSmtpProvider(WEB_ACCOUNT_ID, credential({ email: MAILBOX }));
  const result = await provider.sendMessage({ to: [{ address: 'someone@example.com' }], subject: 'Hello', body: 'Body' });
  assert.equal(result.id, '<stub-message-id@example.com>');
});
