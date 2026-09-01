import { createDAVClient } from 'tsdav';
import type { DAVCalendar } from 'tsdav';
import type {
  AccountCredentials,
  ICalendarProvider,
  CalendarEvent,
  Calendar,
  ListEventsOptions,
  CreateEventInput,
  UpdateEventInput,
} from '@mcp-ecc/core';

// Minimal ICS escaping helpers (RFC 5545)
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toIcsDateTime(ms: number, allDay = false): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  if (allDay) return date;
  return `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function buildIcs(event: CreateEventInput, uid?: string): string {
  const eventUid = uid || `${event.summary ? event.summary.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 32) : 'event'}-${Date.now()}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mcp-ecc//CalDAV//EN',
    'BEGIN:VEVENT',
    `UID:${eventUid}`,
    `DTSTAMP:${toIcsDateTime(Date.now())}`,
    `DTSTART:${toIcsDateTime(event.startAt, event.allDay)}`,
    `DTEND:${toIcsDateTime(event.endAt, event.allDay)}`,
    `SUMMARY:${icsEscape(event.summary || 'Event')}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
  if (event.allDay) lines.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE');
  for (const a of event.attendees || []) {
    lines.push(`ATTENDEE;CN=${icsEscape(a.name || a.address)}:mailto:${a.address}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function parseIcs(data: string, url: string, etag?: string): CalendarEvent {
  const field = (name: string): string => {
    const m = data.match(new RegExp(`^${name}[:;](.*)$`, 'm'));
    if (!m) return '';
    // strip trailing param of the form ;key=value
    const val = m[1];
    if (val.includes(';') && !val.includes(':')) return val.split(';')[0];
    return val.trim();
  };
  const dateTime = (name: string): number => {
    const raw = field(name);
    if (!raw) return Date.now();
    // 20260901T120000Z or 20260901 (all-day)
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
    if (!m) return Date.now();
    if (m[4] === undefined) {
      return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  };
  const isAllDay = field('DTSTART').length === 8;
  return {
    id: url,
    calendarId: url.split('/').slice(0, -1).join('/'),
    summary: field('SUMMARY') || 'No Title',
    description: field('DESCRIPTION') || undefined,
    location: field('LOCATION') || undefined,
    startAt: dateTime('DTSTART'),
    endAt: dateTime('DTEND'),
    allDay: isAllDay,
    status: 'confirmed' as CalendarEvent['status'],
    attendees: [],
    raw: { url, etag, ics: data },
  };
}

export class CalDAVProvider implements ICalendarProvider {
  private clientPromise: Promise<any> | null = null;

  constructor(private accountId: string, private credentials: AccountCredentials) {}

  private getServerUrl(): string {
    const url = this.credentials.config?.caldavUrl || this.credentials.config?.davUrl;
    return typeof url === 'string' ? url : '';
  }

  private async getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = createDAVClient({
        serverUrl: this.getServerUrl(),
        credentials: {
          username: this.accountId,
          password: this.credentials.appPassword || '',
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
    }
    return this.clientPromise;
  }

  private async getCalendars(): Promise<DAVCalendar[]> {
    const client = await this.getClient();
    const account = await client.createAccount({ account: { serverUrl: this.getServerUrl(), accountType: 'caldav', credentials: { username: this.accountId, password: this.credentials.appPassword || '' } }, loadCollections: false, loadObjects: false });
    // tsdav's exported fetchCalendars is broken (raw propfind returns empty
    // props) — discover calendars via the client's working propfind instead.
    const res = await client.propfind({
      url: account.homeUrl || this.getServerUrl(),
      props: {
        'd:resourcetype': {},
        'd:displayname': {},
        'c:supported-calendar-component-set': {},
        'ca:calendar-color': {},
        'c:calendar-description': {},
      },
      depth: '1',
    });
    const cals: DAVCalendar[] = [];
    for (const r of res) {
      const rt = r.props?.resourcetype as Record<string, unknown> | undefined;
      if (!rt || !('calendar' in rt)) continue;
      const compSet = r.props?.supportedCalendarComponentSet as any;
      const comps: string[] = [];
      if (Array.isArray(compSet?.comp)) comps.push(...compSet.comp.map((c: any) => c?._attributes?.name));
      else if (compSet?.comp?._attributes?.name) comps.push(compSet.comp._attributes.name);
      cals.push({
        url: new URL(r.href || '', account.rootUrl || this.getServerUrl()).href,
        displayName: typeof r.props?.displayname === 'string' ? r.props.displayname : (r.props?.displayname as any)?._cdata || undefined,
        description: typeof r.props?.calendarDescription === 'string' ? r.props.calendarDescription : undefined,
        calendarColor: typeof r.props?.calendarColor === 'string' ? r.props.calendarColor : undefined,
        components: comps,
      });
    }
    return cals;
  }

  async listCalendars(): Promise<Calendar[]> {
    const cals = await this.getCalendars();
    return cals.map(cal => ({
      id: cal.url,
      name: typeof cal.displayName === 'string' ? cal.displayName : cal.url.split('/').filter(Boolean).pop() || 'Calendar',
      description: cal.description,
      color: cal.calendarColor,
      primary: false,
      accessRole: 'owner',
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  async listEvents(calendarId: string, options: ListEventsOptions = {}): Promise<CalendarEvent[]> {
    const client = await this.getClient();
    // List .ics objects in the calendar via PROPFIND (tsdav's
    // fetchCalendarObjects fails without auth headers).
    const res = await client.propfind({
      url: calendarId,
      props: { 'd:resourcetype': {}, 'd:getetag': {} },
      depth: '1',
    });
    const events: CalendarEvent[] = [];
    for (const r of res) {
      const href = r.href || '';
      if (!href.endsWith('.ics')) continue;
      const rt = r.props?.resourcetype as Record<string, unknown> | undefined;
      if (rt && Object.keys(rt).length > 0) continue; // collection, not object
      try {
        const ics = await this.fetchObject(calendarId, href);
        if (!ics) continue;
        const ev = parseIcs(ics, new URL(href, calendarId).href, r.props?.getetag as string | undefined);
        if (options.timeMin && ev.endAt < options.timeMin) continue;
        if (options.timeMax && ev.startAt > options.timeMax) continue;
        events.push(ev);
      } catch (e) {
        console.error(`Failed to fetch calendar object ${href}:`, e);
      }
    }
    events.sort((a, b) => a.startAt - b.startAt);
    return options.limit ? events.slice(0, options.limit) : events;
  }

  private async fetchObject(calendarId: string, href: string): Promise<string | null> {
    const client = await this.getClient();
    const url = new URL(href, calendarId).href;
    const res = await client.davRequest({ url, init: { method: 'GET' } });
    const first = Array.isArray(res) ? res[0] : res;
    if (!first) return null;
    // tsdav returns the raw body string in `first.raw` (or a Response in
    // newer versions).
    if (typeof first.raw === 'string' && first.raw.length > 0) return first.raw;
    if (first.raw && typeof first.raw.text === 'function') {
      return await first.raw.text();
    }
    return (first as any).data || (first as any).body || (first as any).text || null;
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const events = await this.listEvents(calendarId);
    const ev = events.find(e => e.id === eventId);
    if (!ev) throw new Error(`Event not found: ${eventId}`);
    return ev;
  }

  async createEvent(calendarId: string, event: CreateEventInput): Promise<CalendarEvent> {
    const client = await this.getClient();
    const ics = buildIcs(event);
    const filename = `mcp-ecc-${Date.now()}.ics`;
    const url = `${calendarId.endsWith('/') ? calendarId : calendarId + '/'}${filename}`;
    await client.createObject({
      url,
      data: ics,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    return parseIcs(ics, url);
  }

  async updateEvent(calendarId: string, eventId: string, patches: UpdateEventInput): Promise<CalendarEvent> {
    const client = await this.getClient();
    const existing = await this.getEvent(calendarId, eventId);
    const merged: CreateEventInput = {
      summary: patches.summary ?? existing.summary,
      description: patches.description !== undefined ? patches.description : existing.description,
      location: patches.location !== undefined ? patches.location : existing.location,
      startAt: patches.startAt ?? existing.startAt,
      endAt: patches.endAt ?? existing.endAt,
      allDay: patches.allDay ?? existing.allDay,
    };
    const ics = buildIcs(merged, (existing.raw?.ics as string | undefined)?.match(/^UID:(.*)$/m)?.[1]?.trim());
    const resp = await client.updateObject({
      url: eventId,
      data: ics,
      etag: existing.raw?.etag as string | undefined,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    if (resp && resp.status && resp.status >= 400) {
      throw new Error(`CalDAV update failed: ${resp.status} ${resp.statusText || ''} ${typeof resp.raw === 'string' ? resp.raw.slice(0, 120) : ''}`);
    }
    return parseIcs(ics, eventId);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const client = await this.getClient();
    const existing = await this.getEvent(calendarId, eventId);
    const resp = await client.deleteObject({
      url: eventId,
      etag: existing.raw?.etag as string | undefined,
    });
    if (resp && resp.status && resp.status >= 400) {
      throw new Error(`CalDAV delete failed: ${resp.status} ${resp.statusText || ''} ${typeof resp.raw === 'string' ? resp.raw.slice(0, 120) : ''}`);
    }
  }

  async freeBusy(calendarIds: string[], timeMin: number, timeMax: number): Promise<Array<{ calendarId: string; busy: Array<{ start: number; end: number }> }>> {
    const results = [];
    for (const calendarId of calendarIds) {
      const events = await this.listEvents(calendarId, { timeMin, timeMax });
      results.push({
        calendarId,
        busy: events.map(e => ({ start: e.startAt, end: e.endAt })),
      });
    }
    return results;
  }
}
