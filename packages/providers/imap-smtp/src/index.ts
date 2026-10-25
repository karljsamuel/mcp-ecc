import { ImapFlow } from 'imapflow';
import type { ListResponse, StatusObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { TransportOptions } from 'nodemailer';
import { UNKNOWN_COUNT } from '@mcp-ecc/core';
import type {
  AccountCredentials,
  IMailProvider,
  ICalendarProvider,
  IContactsProvider,
  EmailMessage,
  MailFolder,
  CalendarEvent,
  Calendar,
  Contact,
  EmailAddress,
  EmailAttachment,
  ListMessagesOptions,
  ListFoldersOptions,
  SearchOptions,
  SendMessageInput,
  ListEventsOptions,
  CreateEventInput,
  UpdateEventInput,
  ListContactsOptions,
  CreateContactInput,
  UpdateContactInput,
} from '@mcp-ecc/core';

/** Result of measuring one folder's unread count. `unread` is absent when the measurement failed. */
interface FolderUnreadMeasurement {
  unread?: number;
  total?: number;
  error?: string;
}

export class ImapSmtpProvider implements IMailProvider, ICalendarProvider, IContactsProvider {
  private imapConfig: ConstructorParameters<typeof ImapFlow>[0];
  private smtpConfig: TransportOptions;

  /** Shared IMAP connection: connected lazily, reused across calls, dropped on error/idle. */
  private imapClient: ImapFlow | null = null;
  private pendingConnect: Promise<ImapFlow> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Short-lived cache of LIST metadata (folders rarely change; counts are never cached). */
  private folderListCache: { at: number; boxes: ListResponse[] } | null = null;

  /** How long a cached mailbox list may be reused. */
  private static readonly FOLDER_LIST_TTL_MS = 30_000;
  /** Close the shared connection after this long without a call. */
  private static readonly IDLE_CLOSE_MS = 5 * 60_000;
  /** Folders whose STATUS is fetched in parallel when the server has no LIST-STATUS. */
  private static readonly COUNT_CONCURRENCY = 5;
  /** Wall-clock budget for the whole per-folder count pass. */
  private static readonly COUNT_BUDGET_MS = 20_000;

  constructor(private accountId: string, private credentials: AccountCredentials) {
    const config = credentials.config || {};

    this.imapConfig = {
      host: config.imapHost || 'imap.gmail.com',
      port: config.imapPort || 993,
      secure: config.imapTls !== false,
      auth: {
        user: accountId,
        pass: credentials.appPassword || '',
      },
      logger: false,
      // Explicit, tight bounds. ImapFlow's defaults would let a single MCP tool call wait 90s
      // for a transport and 5 minutes for socket silence.
      connectionTimeout: 20_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
      // This provider only issues request/response commands, so auto-IDLE would merely add an
      // enter+break round-trip around every burst of calls.
      disableAutoIdle: true,
    };

    this.smtpConfig = {
      host: config.smtpHost || 'smtp.gmail.com',
      port: config.smtpPort || 465,
      secure: config.smtpSecure !== false,
      auth: {
        user: accountId,
        pass: credentials.appPassword || '',
      },
      tls: { rejectUnauthorized: false },
    } as TransportOptions;
  }

  /**
   * Returns the shared connection, connecting only when there is none (or the last one died).
   * Previously every call built a fresh ImapFlow and logged out at the end, so listing folders
   * twice paid the full TCP + TLS + LOGIN handshake twice.
   */
  private async getClient(): Promise<ImapFlow> {
    if (this.imapClient && this.imapClient.usable && this.imapClient.authenticated) {
      this.touchIdleTimer();
      return this.imapClient;
    }
    if (this.pendingConnect) return this.pendingConnect;

    this.pendingConnect = (async () => {
      const client = new ImapFlow(this.imapConfig);
      // ImapFlow re-emits transport failures as 'error'; with no listener Node would treat that
      // as an uncaught exception and take the server down. Dropping the cached client makes the
      // next call reconnect instead of reusing a dead socket.
      client.on('error', (err: Error) => {
        if (this.imapClient === client) this.imapClient = null;
        console.warn(`IMAP connection error for ${this.accountId}: ${err?.message || String(err)}`);
      });
      client.on('close', () => {
        if (this.imapClient === client) this.imapClient = null;
      });
      await client.connect();
      this.imapClient = client;
      this.touchIdleTimer();
      return client;
    })();

    try {
      return await this.pendingConnect;
    } finally {
      this.pendingConnect = null;
    }
  }

  /** Runs `fn` against the shared connection, reconnecting first if it is not usable. */
  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      const result = await fn(client);
      this.touchIdleTimer();
      return result;
    } catch (err) {
      // A dropped socket must not leave a dead client cached for the next call.
      if (!client.usable) await this.close();
      throw err;
    }
  }

  /**
   * Runs `fn` with `path` selected. getMailboxLock both selects the mailbox and serialises
   * concurrent operations on the shared connection (ImapFlow queues commands, but two
   * overlapping SELECTs would otherwise fight over the connection state).
   */
  private async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClient(async client => {
      const lock = await client.getMailboxLock(path);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  /** Closes the shared connection. Safe to call at any time; the next call reconnects. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const client = this.imapClient;
    this.imapClient = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // Already gone.
      }
    }
  }

  /** Keeps the shared connection from living forever without traffic. */
  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timer = setTimeout(() => {
      void this.close();
    }, ImapSmtpProvider.IDLE_CLOSE_MS);
    // Never hold the process open just for this timer.
    if (typeof timer.unref === 'function') timer.unref();
    this.idleTimer = timer;
  }

  // --- IMailProvider ---

  /**
   * Per-folder unread counts in a single LIST round-trip where the server allows it.
   *
   * The previous implementation opened every mailbox and searched it (`mailboxOpen` +
   * `SEARCH UNSEEN`), which is ~2N+4 sequential round-trips for N folders (~104 for a 50-folder
   * account) and gave no total counts.
   *
   * Now: `client.list({ statusQuery: { unseen: true, messages: true } })` returns MESSAGES and
   * UNSEEN for every folder inside the LIST response itself on servers that advertise LIST-STATUS
   * (RFC 5819, folded into IMAP4rev2). Only when the server does not answer inline are the
   * missing counts resolved with `client.status(path, { unseen: true, messages: true })` - one
   * round-trip per folder, without SELECT - through a bounded worker pool (ImapFlow may serialise
   * the underlying wire traffic itself; the pool bounds how many lookups are in flight and how
   * long the pass may take).
   *
   * `MailboxObject.unseen` is deliberately not used anywhere here: ImapFlow documents it as the
   * sequence number of the first unseen message, not a count.
   */
  async listFolders(options: ListFoldersOptions = {}): Promise<MailFolder[]> {
    const withCounts = options.withUnreadCounts !== false;

    return this.withClient(async client => {
      const boxes = await this.listBoxes(client, withCounts);
      const selected = options.folderId
        ? boxes.filter(box => this.matchesFolderFilter(box.path, box.name, options.folderId))
        : boxes;

      const statuses = withCounts
        ? await this.collectStatuses(client, selected)
        : new Map<string, FolderUnreadMeasurement>();

      return selected.map(box => this.toMailFolder(box, withCounts, statuses.get(box.path)));
    });
  }

  /** LIST metadata, cached briefly for cheap (count-free) listings. */
  private async listBoxes(client: ImapFlow, withCounts: boolean): Promise<ListResponse[]> {
    if (!withCounts) {
      const cached = this.folderListCache;
      if (cached && Date.now() - cached.at < ImapSmtpProvider.FOLDER_LIST_TTL_MS) {
        return cached.boxes;
      }
    }

    // statusQuery is passed only when the server advertises LIST-STATUS: ImapFlow would otherwise
    // fall back to one sequential STATUS command per mailbox, which is exactly the N-round-trip
    // behaviour this method exists to avoid.
    const useInlineStatus = withCounts && this.supportsListStatus(client);
    const boxes = await client.list(
      useInlineStatus ? { statusQuery: { unseen: true, messages: true } } : undefined
    );

    this.folderListCache = { at: Date.now(), boxes };
    return boxes;
  }

  /**
   * Mirrors ImapFlow's own hasCapability(): 'LIST-STATUS' is advertised by IMAP4rev1 servers and
   * folded into the IMAP4rev2 base specification (RFC 9051 Appendix E).
   */
  private supportsListStatus(client: ImapFlow): boolean {
    const capabilities = client.capabilities;
    if (capabilities.has('LIST-STATUS')) return true;
    const rev2Active =
      client.enabled?.has('IMAP4REV2') === true ||
      (capabilities.has('IMAP4rev2') && !capabilities.has('IMAP4rev1'));
    return Boolean(rev2Active);
  }

  /** Fills in counts for every folder the LIST response did not already cover. */
  private async collectStatuses(
    client: ImapFlow,
    boxes: ListResponse[]
  ): Promise<Map<string, FolderUnreadMeasurement>> {
    const results = new Map<string, FolderUnreadMeasurement>();
    const pending: ListResponse[] = [];

    for (const box of boxes) {
      if (this.isContainer(box)) {
        // \Noselect / \NonExistent mailboxes cannot hold messages, so 0 here is the exact
        // answer, not a fallback for a failed lookup.
        results.set(box.path, { unread: 0, total: 0 });
        continue;
      }

      const inline = box.status as (StatusObject & { error?: unknown }) | undefined;
      if (typeof inline?.unseen === 'number') {
        results.set(box.path, {
          unread: inline.unseen,
          total: typeof inline.messages === 'number' ? inline.messages : undefined,
        });
      } else {
        pending.push(box);
      }
    }

    if (!pending.length) return results;

    const deadline = Date.now() + ImapSmtpProvider.COUNT_BUDGET_MS;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(ImapSmtpProvider.COUNT_CONCURRENCY, pending.length) },
      async () => {
        while (cursor < pending.length) {
          const box = pending[cursor++];
          if (Date.now() > deadline) {
            results.set(box.path, {
              error: `STATUS lookup skipped: ${ImapSmtpProvider.COUNT_BUDGET_MS}ms budget exhausted`,
            });
            continue;
          }
          try {
            const status = await client.status(box.path, { unseen: true, messages: true });
            results.set(box.path, {
              unread: typeof status.unseen === 'number' ? status.unseen : undefined,
              total: typeof status.messages === 'number' ? status.messages : undefined,
            });
          } catch (err) {
            results.set(box.path, {
              error: `STATUS failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    );
    await Promise.all(workers);

    return results;
  }

  private isContainer(box: ListResponse): boolean {
    return box.flags?.has('\\Noselect') === true || box.flags?.has('\\NonExistent') === true;
  }

  private matchesFolderFilter(path: string, name: string, folderId?: string): boolean {
    if (!folderId) return true;
    const wanted = folderId.trim().toLowerCase();
    return path.toLowerCase() === wanted || (name || '').toLowerCase() === wanted;
  }

  private toMailFolder(
    box: ListResponse,
    withCounts: boolean,
    status?: FolderUnreadMeasurement
  ): MailFolder {
    const name = box.name || box.path;
    const folder: MailFolder = {
      id: box.path,
      name,
      type: this.mapFolderType(name, box.specialUse),
      unreadCount: UNKNOWN_COUNT,
      totalCount: UNKNOWN_COUNT,
      createdAt: 0,
      updatedAt: 0,
    };

    if (!withCounts) {
      // Counts were not requested. UNKNOWN_COUNT (and no error) says exactly that - the old
      // implementation's 0 was indistinguishable from a genuinely empty folder.
      return folder;
    }

    if (status?.unread !== undefined) {
      folder.unreadCount = status.unread;
      if (status.total !== undefined) folder.totalCount = status.total;
      return folder;
    }

    // Not measurable: keep the sentinel and say why, instead of the previous silent 0.
    folder.unreadCountError = status?.error || 'server did not report an UNSEEN count for this folder';
    return folder;
  }

  async listMessages(folderId: string, options: ListMessagesOptions = {}): Promise<{ items: EmailMessage[]; nextCursor?: string; total?: number }> {
    return this.withMailbox(folderId, async client => {
      const search: any = { all: true };
      if (options.query) {
        const q = options.query.trim();
        if (q.toLowerCase() === 'is:unread') {
          search.seen = false;
        } else {
          search.text = q;
        }
      }
      if (options.unreadOnly && !search.seen) {
        search.seen = false;
      }

      const messages = await client.search(search, { uid: true });
      const list = messages || [];
      const offset = options.cursor ? Number(options.cursor) : 0;
      const pageSize = options.limit || 50;
      const sliced = list.slice(Math.max(0, list.length - offset - pageSize), list.length - offset).reverse();

      const emailMessages: EmailMessage[] = [];
      for (const range of sliced) {
        try {
          const fetched = await client.fetchOne(range, { source: true, flags: true }, { uid: true });
          if (!fetched || !fetched.source) continue;
          const parsed = await simpleParser(fetched.source);
          emailMessages.push(this.mapParsedMessage(parsed, String(fetched.uid), folderId, fetched.flags));
        } catch (err) {
          console.error(`Failed to parse message ${range}:`, err);
        }
      }

      return { items: emailMessages, nextCursor: offset + sliced.length < list.length ? String(offset + sliced.length) : undefined, total: list.length };
    });
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    return this.withMailbox('INBOX', async client => {
      const uid = messageId.includes(':') ? messageId.split(':').pop()! : messageId;
      const fetched = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`Message ${messageId} not found`);
      }
      const parsed = await simpleParser(fetched.source);
      return this.mapParsedMessage(parsed, String(fetched.uid), 'INBOX', fetched.flags);
    });
  }

  async sendMessage(message: SendMessageInput): Promise<EmailMessage> {
    const transporter = nodemailer.createTransport(this.smtpConfig);

    const mailOptions = {
      from: this.accountId,
      to: message.to.map(a => a.address).join(', '),
      cc: message.cc?.map(a => a.address).join(', '),
      bcc: message.bcc?.map(a => a.address).join(', '),
      subject: message.subject,
      text: message.body,
      html: message.htmlBody,
      inReplyTo: message.inReplyTo,
      references: message.references?.join(' '),
    };

    await transporter.sendMail(mailOptions);
    transporter.close();

    return {
      id: 'sent',
      from: { address: this.accountId },
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body,
      htmlBody: message.htmlBody,
      date: Date.now(),
      unread: false,
      starred: false,
      labelsOrFolders: ['SENT'],
    };
  }

  async searchMessages(query: string, options: SearchOptions = {}): Promise<{ items: EmailMessage[]; nextCursor?: string; total?: number }> {
    return this.listMessages('INBOX', { ...options, query });
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    return this.withMailbox('INBOX', async client => {
      await client.messageMove(messageId, folderId, { uid: true });
    });
  }

  async setFlags(messageId: string, addFlags: string[], removeFlags: string[]): Promise<void> {
    return this.withMailbox('INBOX', async client => {
      const toAdd: string[] = [];
      const toRemove: string[] = [];

      if (addFlags.includes('\\Seen')) toAdd.push('\\Seen');
      if (addFlags.includes('\\Flagged')) toAdd.push('\\Flagged');
      if (addFlags.includes('\\Deleted')) toAdd.push('\\Deleted');

      if (removeFlags.includes('\\Seen')) toRemove.push('\\Seen');
      if (removeFlags.includes('\\Flagged')) toRemove.push('\\Flagged');
      if (removeFlags.includes('\\Deleted')) toRemove.push('\\Deleted');

      if (toAdd.length) await client.messageFlagsAdd(messageId, toAdd, { uid: true });
      if (toRemove.length) await client.messageFlagsRemove(messageId, toRemove, { uid: true });
    });
  }

  async deleteMessage(messageId: string, permanent = false): Promise<void> {
    return this.withMailbox('INBOX', async client => {
      if (permanent) {
        await client.messageDelete(messageId, { uid: true });
      } else {
        await client.messageMove(messageId, 'Trash', { uid: true });
      }
    });
  }

  // --- ICalendarProvider (Unsupported) ---

  async listCalendars(): Promise<Calendar[]> {
    return [];
  }

  async listEvents(): Promise<{ items: CalendarEvent[] }> {
    return { items: [] };
  }

  async getEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async createEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async updateEvent(): Promise<CalendarEvent> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async deleteEvent(): Promise<void> {
    throw new Error('Calendar not supported by IMAP/SMTP provider');
  }

  async freeBusy(): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    return [];
  }

  // --- IContactsProvider (Unsupported) ---

  async listContacts(): Promise<{ items: Contact[] }> {
    return { items: [] };
  }

  async getContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async createContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async updateContact(): Promise<Contact> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async deleteContact(): Promise<void> {
    throw new Error('Contacts not supported by IMAP/SMTP provider');
  }

  async searchContacts(): Promise<{ items: Contact[] }> {
    return { items: [] };
  }

  // --- Helpers ---

  private mapParsedMessage(parsed: any, id: string, folderId: string, flags: any = []): EmailMessage {
    // imapflow returns flags as a Set — normalise to an array.
    const flagList = Array.isArray(flags) ? flags : Array.from(flags || []);
    return {
      id,
      threadId: parsed.references ? parsed.references[0] : undefined,
      from: parsed.from ? { name: parsed.from.text, address: parsed.from.value[0]?.address } : { address: '' },
      to: Array.isArray(parsed.to) ? parsed.to.map((t: any) => ({ name: t.name, address: t.address })) : parsed.to ? [{ name: parsed.to.name, address: parsed.to.address }] : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((t: any) => ({ name: t.name, address: t.address })) : parsed.cc ? [{ name: parsed.cc.name, address: parsed.cc.address }] : [],
      bcc: [],
      subject: parsed.subject || '',
      snippet: (parsed.text || '').substring(0, 200),
      body: parsed.text || '',
      htmlBody: parsed.html || undefined,
      date: new Date(parsed.date || Date.now()).getTime(),
      unread: !flagList.includes('\\Seen'),
      starred: flagList.includes('\\Flagged') || false,
      labelsOrFolders: [folderId],
      attachments: parsed.attachments?.map((a: any) => ({
        filename: a.filename || 'attachment',
        mimeType: a.contentType,
        size: a.size,
        contentId: a.contentId,
      })),
    };
  }

  private mapFolderType(name: string, specialUse?: string): MailFolder['type'] {
    // The server's own special-use attribute (RFC 6154) beats guessing from the display name,
    // which is localised.
    if (specialUse) {
      const special = specialUse.toLowerCase();
      if (special === '\\sent') return 'sent';
      if (special === '\\drafts') return 'drafts';
      if (special === '\\trash') return 'trash';
      if (special === '\\junk') return 'spam';
      if (special === '\\archive') return 'archive';
      if (special === '\\flagged') return 'starred';
    }

    const lower = name.toLowerCase();
    if (lower.includes('inbox')) return 'inbox';
    if (lower.includes('sent')) return 'sent';
    if (lower.includes('draft')) return 'drafts';
    if (lower.includes('trash') || lower.includes('deleted')) return 'trash';
    if (lower.includes('spam') || lower.includes('junk')) return 'spam';
    if (lower.includes('archive')) return 'archive';
    return 'custom';
  }
}