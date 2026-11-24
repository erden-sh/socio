import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sqliteData } from '@socio/data/open';
import {
    CalendarInputError,
    EVENT_LIMITS,
    EVENT_STATUSES,
    EVENT_VISIBILITIES,
    MAX_LIST,
    MAX_RANGE_DAYS,
    addDaysToKey,
    dayKeyIn,
    dayStart,
    eventTimes,
    normalizeSource,
    normalizeSourceId,
    parseEventDay,
    parseEventTime,
    type CalendarEventInput,
    type CalendarEventView,
    type EventStatus,
    type EventTimes,
} from '@socio/shared/calendar';
import { isHttpsUrl } from '@socio/shared/https-url';
import { isAdmin } from '@socio/shared/roles';
import { ianaTimeZone } from '@socio/shared/time-zone';
import type { User } from '@socio/shared/types';

import type { PluginContext } from '../bundle-types.js';
import { PluginToolError } from '../errors.js';

import { SqliteCalendar, type EventInsert, type EventPatch, type EventRow } from './infra/repository.js';

/** The install's settings (manifest `config`), read with their defaults. */
export interface CalendarSettings {
    /** The calendar's zone: the install's, else the workspace's. */
    timeZone: string;
    /** Who may add events: everyone the plugin is for, or admins only. */
    writers: 'everyone' | 'admins';
    /** Whether people may change events someone else created. */
    editing: 'own' | 'everyone';
}

export function calendarSettings(ctx: PluginContext): CalendarSettings {
    const config = ctx.config();
    return {
        timeZone: ianaTimeZone(config.timeZone) ?? ctx.workspaceTimeZone(),
        writers: config.writers?.trim() === 'admins' ? 'admins' : 'everyone',
        editing: config.editing?.trim() === 'everyone' ? 'everyone' : 'own',
    };
}

/** Which event a change names: its id, or the source and source id it was copied with. */
export interface EventRef {
    id?: string;
    source?: string;
    sourceId?: string;
}

export interface EventQuery {
    /** A date (`YYYY-MM-DD`), a wall-clock time in the calendar's zone, an ISO time, or epoch ms. */
    from?: string | number;
    /** Same forms; a date is inclusive (the whole day). */
    to?: string | number;
    location?: string;
    status?: EventStatus;
    source?: string;
    sourceId?: string;
    /** Only events this person created. */
    mine?: boolean;
    query?: string;
    limit?: number;
}

const FEED_PREFIX = 'cbcal_';
const feedHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** A feed read records when it was last used, at most this often. */
const FEED_TOUCH_MS = 10 * 60_000;
/** What a feed shows: from this far back to `MAX_RANGE_DAYS` ahead. */
const FEED_PAST_DAYS = 90;

const bad = (message: string) => new PluginToolError(message, 400);

function text(value: unknown, field: keyof typeof EVENT_LIMITS, label: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw bad(`${label} must be text.`);
    }
    const trimmed = field === 'description' ? value : value.trim();
    if (trimmed.length > EVENT_LIMITS[field]) {
        throw bad(`${label} can be at most ${EVENT_LIMITS[field]} characters.`);
    }
    return trimmed;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw bad(`${label} must be one of ${values.join(', ')}.`);
    }
    return value as T;
}

function sourceUrlOf(value: unknown) {
    const url = text(value, 'sourceUrl', 'sourceUrl');
    if (url === undefined || url === '') {
        return url;
    }
    if (!isHttpsUrl(url)) {
        throw bad('sourceUrl must be an https URL.');
    }
    return url;
}

function timesOf(input: Parameters<typeof eventTimes>[0]): EventTimes {
    try {
        return eventTimes(input);
    } catch (error) {
        if (error instanceof CalendarInputError) {
            throw bad(error.message);
        }
        throw error;
    }
}

/**
 * The calendar's events for one plugin context: who may see, add and
 * change what, deduplication on a source id, and times in zones. The
 * routes, the tools and the feed all go through here, so the rules are
 * the same however a person (or their agent or socio) reaches it.
 */
export class CalendarEvents {
    private repo: SqliteCalendar;

    constructor(private ctx: PluginContext) {
        this.repo = new SqliteCalendar(sqliteData(ctx.db));
    }

    settings() {
        return calendarSettings(this.ctx);
    }

    /** Adding events: the install's audience, or its admins when `writers` says so. */
    canWrite(person: User) {
        if (!this.ctx.mayUse(person)) {
            return false;
        }
        return isAdmin(person) || this.settings().writers === 'everyone';
    }

    /** Shared events, and a person's own private ones. Admins see no one else's private events. */
    canSee(row: EventRow, person: User) {
        return row.visibility === 'workspace' || row.createdBy === person.id;
    }

    /**
     * Changing or deleting: the person who created it, an admin (for shared
     * events), or anyone who may write when the install's `editing` is
     * `everyone`.
     */
    canEdit(row: EventRow, person: User) {
        if (!this.canSee(row, person) || !this.ctx.mayUse(person)) {
            return false;
        }
        if (row.createdBy === person.id) {
            return true;
        }
        if (row.visibility === 'private') {
            return false;
        }
        if (isAdmin(person)) {
            return true;
        }
        return this.settings().editing === 'everyone' && this.canWrite(person);
    }

    private names() {
        return new Map(this.ctx.users().map((user) => [user.id, user.name]));
    }

    view(row: EventRow, person: User, names = this.names()): CalendarEventView {
        const who = (id: string) => ({
            id,
            name: names.get(id) ?? 'Someone no longer here',
        });
        return {
            id: row.id,
            title: row.title,
            description: row.description,
            location: row.location,
            status: row.status,
            allDay: row.allDay,
            timeZone: row.timeZone,
            start: new Date(row.startAt).toISOString(),
            end: new Date(row.endAt).toISOString(),
            startAt: row.startAt,
            endAt: row.endAt,
            startLocal: row.startLocal,
            endLocal: row.endLocal,
            source: row.source,
            sourceId: row.sourceId,
            sourceUrl: row.sourceUrl,
            visibility: row.visibility,
            createdBy: who(row.createdBy),
            createdVia: row.createdVia,
            updatedBy: who(row.updatedBy),
            createdAt: new Date(row.createdAt).toISOString(),
            updatedAt: new Date(row.updatedAt).toISOString(),
            canEdit: this.canEdit(row, person),
        };
    }

    /** A range bound: epoch ms, a date, a wall-clock time in `zone`, or an ISO time. */
    private bound(value: string | number, zone: string, end: boolean) {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw bad('A range bound is not a time.');
            }
            return value;
        }
        const time = parseEventTime(value, zone);
        if (time !== undefined) {
            return time;
        }
        const day = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? parseEventDay(value) : undefined;
        if (!day) {
            throw bad(`from and to are dates (YYYY-MM-DD), times (YYYY-MM-DDTHH:mm in ${zone}) or ISO times.`);
        }
        return dayStart(end ? addDaysToKey(day, 1) : day, zone);
    }

    /** Events that overlap a range, as `person` may see them. */
    async list(person: User, query: EventQuery = {}, now = Date.now()) {
        const zone = this.settings().timeZone;
        const from =
            query.from === undefined || query.from === ''
                ? dayStart(dayKeyIn(now, zone), zone)
                : this.bound(query.from, zone, false);
        const to =
            query.to === undefined || query.to === ''
                ? dayStart(addDaysToKey(dayKeyIn(from, zone), 7), zone)
                : this.bound(query.to, zone, true);
        if (to <= from) {
            throw bad('to must be after from.');
        }
        if (to - from > MAX_RANGE_DAYS * 86_400_000) {
            throw bad(`A range can cover at most ${MAX_RANGE_DAYS} days.`);
        }
        const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 200)), MAX_LIST);
        const source = normalizeSourceSafe(query.source);
        const rows = await this.repo.list({
            from,
            to,
            viewer: person.id,
            ...(query.location?.trim() ? { location: query.location.trim() } : {}),
            ...(query.status ? { status: oneOf(query.status, EVENT_STATUSES, 'status') } : {}),
            ...(source ? { source } : {}),
            ...(query.sourceId?.trim() ? { sourceId: normalizeSourceId(source ?? '', query.sourceId) } : {}),
            ...(query.mine ? { createdBy: person.id } : {}),
            ...(query.query?.trim() ? { query: query.query.trim() } : {}),
            limit: limit + 1,
        });
        const names = this.names();
        return {
            timeZone: zone,
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            events: rows.slice(0, limit).map((row) => this.view(row, person, names)),
            truncated: rows.length > limit,
        };
    }

    private async find(person: User, ref: EventRef) {
        let row: EventRow | undefined;
        if (ref.id?.trim()) {
            row = await this.repo.get(ref.id.trim());
        } else if (ref.source?.trim() && ref.sourceId?.trim()) {
            const source = normalizeSourceSafe(ref.source)!;
            row = await this.repo.bySource(source, normalizeSourceId(source, ref.sourceId));
        } else {
            throw bad('Name the event by id, or by source and sourceId.');
        }
        if (!row || !this.canSee(row, person)) {
            throw new PluginToolError('No such event.', 404);
        }
        return row;
    }

    async get(person: User, ref: EventRef) {
        return this.view(await this.find(person, ref), person);
    }

    /**
     * Adds an event. When it names a source and source id that an event
     * already has (a sync running twice, the same Notion page), that event
     * is updated with what this call sends instead, if the person may change
     * it; otherwise the call is refused. `outcome` says which happened.
     */
    async create(person: User, input: CalendarEventInput, via = '', now = Date.now()) {
        if (!this.canWrite(person)) {
            throw new PluginToolError('You can’t add events to this calendar.', 403);
        }
        const title = text(input.title, 'title', 'Title');
        if (!title) {
            throw bad('An event needs a title.');
        }
        const zone = this.zoneOf(input.timeZone);
        if (typeof input.start !== 'string' || !input.start.trim()) {
            throw bad('An event needs a start.');
        }
        const times = timesOf({
            start: input.start,
            ...(input.end !== undefined ? { end: input.end } : {}),
            ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
            timeZone: zone,
        });
        const source = normalizeSourceSafe(input.source) ?? '';
        const sourceId = normalizeSourceId(source, text(input.sourceId, 'sourceId', 'sourceId'));
        if (sourceId && !source) {
            throw bad('Name the source of a sourceId, for example notion.');
        }
        const fields = {
            title,
            ...defined({
                description: text(input.description, 'description', 'Description'),
                location: text(input.location, 'location', 'Location'),
                status: oneOf(input.status, EVENT_STATUSES, 'status'),
                visibility: oneOf(input.visibility, EVENT_VISIBILITIES, 'visibility'),
                sourceUrl: sourceUrlOf(input.sourceUrl),
            }),
            ...times,
        };
        const row: EventInsert = {
            id: randomUUID(),
            description: '',
            location: '',
            status: 'confirmed',
            visibility: 'workspace',
            sourceUrl: '',
            ...fields,
            source,
            sourceId,
            createdBy: person.id,
            createdVia: via.slice(0, 200),
            updatedBy: person.id,
            createdAt: now,
            updatedAt: now,
        };
        const result = await this.repo.createOrMatch(row, (existing) => {
            if (!this.canEdit(existing, person)) {
                throw new PluginToolError(
                    'An event with that source and sourceId already exists, and you can’t change it.',
                    409,
                );
            }
            const patch = changes(existing, fields);
            return Object.keys(patch).length ? { ...patch, updatedBy: person.id, updatedAt: now } : undefined;
        });
        const saved = (await this.repo.get(result.id))!;
        return { outcome: result.outcome, event: this.view(saved, person) };
    }

    /**
     * Changes the fields sent and leaves the rest. A new start without an
     * end keeps the event's length; a zone without times keeps its wall
     * clock (9:00 stays 9:00, in the new zone).
     */
    async update(person: User, ref: EventRef, patch: Partial<CalendarEventInput>, now = Date.now()) {
        const row = await this.find(person, ref);
        if (!this.canEdit(row, person)) {
            throw new PluginToolError('You can’t change this event.', 403);
        }
        const title = text(patch.title, 'title', 'Title');
        if (title === '') {
            throw bad('An event needs a title.');
        }
        const zone = patch.timeZone !== undefined ? this.zoneOf(patch.timeZone) : row.timeZone;
        const timing =
            patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined || zone !== row.timeZone;
        let times: EventTimes | undefined;
        if (timing) {
            const allDay = patch.allDay ?? row.allDay;
            let start = patch.start ?? row.startLocal;
            if (allDay && !row.allDay && patch.start === undefined) {
                start = row.startLocal.slice(0, 10);
            }
            let end = patch.end;
            if (end === undefined) {
                if (allDay && row.allDay && patch.start === undefined) {
                    end = row.endLocal;
                } else if (!allDay && !row.allDay) {
                    const startAt = parseEventTime(start, zone);
                    if (startAt !== undefined) {
                        end = new Date(startAt + (row.endAt - row.startAt)).toISOString();
                    }
                }
            }
            times = timesOf({
                start,
                ...(end !== undefined ? { end } : {}),
                allDay,
                timeZone: zone,
            });
        }
        const fields = defined({
            title,
            description: text(patch.description, 'description', 'Description'),
            location: text(patch.location, 'location', 'Location'),
            status: oneOf(patch.status, EVENT_STATUSES, 'status'),
            visibility: oneOf(patch.visibility, EVENT_VISIBILITIES, 'visibility'),
            sourceUrl: sourceUrlOf(patch.sourceUrl),
        });
        // Only the person who created an event makes it private: an admin
        // making someone's shared event private would hide it from them both.
        if (fields.visibility === 'private' && row.visibility !== 'private' && row.createdBy !== person.id) {
            throw new PluginToolError('Only the person who created an event can make it private.', 403);
        }
        const changed = changes(row, { ...fields, ...times });
        if (Object.keys(changed).length) {
            await this.repo.update(row.id, {
                ...changed,
                updatedBy: person.id,
                updatedAt: now,
            });
        }
        return { event: this.view((await this.repo.get(row.id))!, person) };
    }

    async remove(person: User, ref: EventRef) {
        const row = await this.find(person, ref);
        if (!this.canEdit(row, person)) {
            throw new PluginToolError('You can’t delete this event.', 403);
        }
        await this.repo.delete(row.id);
        return { deleted: row.id, title: row.title };
    }

    private zoneOf(value: string | undefined) {
        if (value === undefined || value === '') {
            return this.settings().timeZone;
        }
        const zone = ianaTimeZone(value);
        if (!zone) {
            throw bad(`${value} is not a time zone. Use an IANA name such as America/New_York.`);
        }
        return zone;
    }

    /** Whether this person has a feed, and since when. */
    async feedState(person: User) {
        const feed = await this.repo.feedOf(person.id);
        return feed ? { active: true, createdAt: new Date(feed.createdAt).toISOString() } : { active: false };
    }

    /**
     * A new private subscription link for `person`, replacing their old one.
     * Only its hash is stored; the link is shown once.
     */
    async createFeed(person: User, now = Date.now()) {
        if (!this.ctx.mayUse(person)) {
            throw new PluginToolError('You can’t use this calendar.', 403);
        }
        const token = `${FEED_PREFIX}${randomBytes(24).toString('base64url')}`;
        await this.repo.replaceFeed(person.id, feedHash(token), now);
        return {
            url: `${this.ctx.origin.replace(/\/$/, '')}/plugin-feeds/${this.ctx.id}/${token}.ics`,
        };
    }

    async deleteFeed(person: User) {
        await this.repo.deleteFeed(person.id);
        return { ok: true };
    }

    /**
     * The events behind a feed token, as its person may see them now: a
     * token whose person was deactivated, or left the plugin's audience,
     * shows nothing (undefined).
     */
    async feedEvents(token: string, now = Date.now()) {
        const bare = token.replace(/\.ics$/, '');
        if (!bare.startsWith(FEED_PREFIX) || bare.length > 100) {
            return undefined;
        }
        const hash = feedHash(bare);
        const feed = await this.repo.feedByHash(hash);
        if (!feed) {
            return undefined;
        }
        const person = this.ctx.users().find((user) => user.id === feed.userId);
        if (!person || !this.ctx.mayUse(person)) {
            return undefined;
        }
        if (!feed.lastUsedAt || feed.lastUsedAt + FEED_TOUCH_MS <= now) {
            await this.repo.touchFeed(hash, now);
        }
        const rows = await this.repo.list({
            from: now - FEED_PAST_DAYS * 86_400_000,
            to: now + MAX_RANGE_DAYS * 86_400_000,
            viewer: person.id,
            limit: 5000,
        });
        return { person, rows };
    }
}

function normalizeSourceSafe(value: string | undefined) {
    try {
        return normalizeSource(value) || undefined;
    } catch (error) {
        if (error instanceof CalendarInputError) {
            throw bad(error.message);
        }
        throw error;
    }
}

function defined<T extends Record<string, unknown>>(row: T) {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as {
        [K in keyof T]?: Exclude<T[K], undefined>;
    };
}

/** The fields of `next` that differ from `row`. */
function changes(
    row: EventRow,
    next: Partial<
        Pick<
            EventRow,
            | 'title'
            | 'description'
            | 'location'
            | 'status'
            | 'visibility'
            | 'sourceUrl'
            | 'allDay'
            | 'timeZone'
            | 'startAt'
            | 'endAt'
            | 'startLocal'
            | 'endLocal'
        >
    >,
): EventPatch {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
        if (value !== undefined && row[key as keyof EventRow] !== value) {
            patch[key] = value;
        }
    }
    return patch as EventPatch;
}
