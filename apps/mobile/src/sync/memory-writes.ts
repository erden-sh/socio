import {
    MEMORY_TEXT_MAX,
    type MemoriesState,
    type MemoryItem,
    PROFILE_FIELD_MAX,
    PROFILE_FIELDS,
    type ProfileField,
    type ProfileFields,
    type UserProfile,
} from '@socio/shared/memory';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { NetworkError } from '../net/errors';

import { MEMORIES, MEMORY_PROFILE, type MemoryProfileRow, PROFILE_KEY } from './memories';
import type {
    CheckOutcome,
    NewOutboxWrite,
    Outbox,
    OutboxContext,
    OutboxKind,
    OutboxRow,
    OutboxWrite,
    SendOutcome,
    Settled,
} from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, reasonOf, type WriteMethod } from './outbox-answers';
import type { Overlay, OverlayItem, OverlayKind } from './outbox-overlay';
import { serverSince } from './server-clock';
import type { SnapshotCache } from './snapshot-cache';

// Memories and profile writes: the person's own memories,
// the proposals their socios made, their profile, and the moved time zone's note,
// each an outbox kind against src/server/memory/routes.ts.
//
// - **Lanes.** A memory's writes go in order in `memory:<id>`; a memory
//   added on the phone has a local id (`pending-memory-<uuid>`, never
//   `local-`, which `isLocalChat` takes) until its create resolves, and the
//   `ids` map then gives the server's (`memory`). A write to it waits for
//   the create (`dependsOn`) in the local id's lane, and a later one joins
//   that lane while it holds a write, so they never pass each other. The
//   profile's saves and clears go in `profile`, the note's mark in
//   `memory-note`.
// - **Add** (`POST /api/memories`, not safe to repeat): the text trimmed as
//   the server stores it. A 201's id goes to `ids`. A proxy's page, a plain
//   5xx or no answer is `unknown`, and the check reads `/api/memories`
//   for the person's own memory (`source: 'person'`, no socio) with exactly
//   this text, made after the newest memory the phone held and at or after
//   the server's Date less the slack (`serverSince`), and no other write's
//   (`context.claimed`): one is the create's, none goes again, two the
//   person decides (View, Send again).
// - **Edit** (`PUT /memories/:id`) keeps each field's **first** base (the
//   stored value the person saw, or what their own newest unsettled write
//   in the lane sets it to, never another overlay's): a later edit folds
//   into the lane's newest row when that is a queued edit, and keeps its
//   bases; a refused edit's other fields join a newer one, so none is lost
//   (a profile save does the same). At the start of `send` the kind reads
//   `/api/memories` again; a field changed there to something else than
//   both the base and this write goes to `unsent` (`conflict`, "Couldn't
//   save", with Keep mine and Keep theirs, `keepMine`/`keepTheirs`). One
//   already as written (an earlier attempt landed) is done.
// - **Approve, "Still true" and delete** (`POST …/approve`, `…/confirm`,
//   `DELETE`; soft on the server) are safe to repeat, and a 404 is done: the
//   memory is gone, approved or deleted elsewhere, and nothing is left to
//   do. A delete of a memory still queued on the phone removes its rows
//   there, with no request.
// - **The profile** (`PUT /memories/profile`) is stored exactly as sent
//   (`profiles.save`), so the kind re-reads `/api/memories` at the start of
//   `send`, compares each changed field's base as an edit does, and sends
//   the whole profile: the fresh fields with this row's changes on top. A
//   time zone is checked with shared's `ianaTimeZone` before it is queued.
//   **Clear** (`DELETE`) is safe to repeat.
// - **The moved time zone's note** (`POST …/time-zone-note/seen`) goes only
//   while `/api/memories` still names that zone; a stale one is dropped, as
//   is a refusal: nothing for the person to do about a mark.
// - **Episodes are not here:** their deletes are hard and remove whatever is
//   there on arrival, so Memories sends them online only (memory-episodes.ts).
//
// Each confirmed answer is handed to cache.db's `memories` or
// `memory-profile` before its row goes, so the list never flickers
// back. Never the server's text: statuses and codes only. No React
// Native: tests/sync runs it under Node against a fake server.

export const MEMORY_ADD_KIND = 'memory-add';
export const MEMORY_UPDATE_KIND = 'memory-update';
export const MEMORY_APPROVE_KIND = 'memory-approve';
export const MEMORY_CONFIRM_KIND = 'memory-confirm';
export const MEMORY_DELETE_KIND = 'memory-delete';
export const PROFILE_SAVE_KIND = 'profile-save';
export const PROFILE_CLEAR_KIND = 'profile-clear';
export const TIME_ZONE_SEEN_KIND = 'time-zone-seen';
const VERSION = 1;

/** The `ids` map's kind for an added memory's server id. */
export const MEMORY_IDS = 'memory';

/** The reasons these rows carry after a refusal (`UNSENT_REASON_COPY` words them). */
export const MEMORY_REASON = {
    /** The memory was deleted (or isn't the person's). */
    gone: 'memory-gone',
    /** Its memory was added on the phone and never created. */
    noMemory: 'no-memory',
    /** Changed somewhere else first: Keep mine or Keep theirs. */
    conflict: 'conflict',
    content: 'content',
} as const;

const LOCAL_PREFIX = 'pending-memory-';

/** A new memory's local id from a fresh UUID (expo-crypto). */
export const newLocalMemoryId = (newId: () => string) => `${LOCAL_PREFIX}${newId()}`;
/** Whether `id` is a memory's local id, never a server's. */
export const isLocalMemory = (id: string) => id.startsWith(LOCAL_PREFIX) && id.length > LOCAL_PREFIX.length;

type Resolve = (kind: string, localId: string) => string | null;
/** Memory `id` as the server knows it: a local id's server id, null while its create hasn't resolved. */
const serverMemoryId = (resolve: Resolve, id: string) => (isLocalMemory(id) ? resolve(MEMORY_IDS, id) : id);
/** Memory `id` for a screen: a resolved local id's server id, else `id`. */
export const shownMemoryId = (resolve: Resolve, id: string) => serverMemoryId(resolve, id) ?? id;

const MEMORY_LANE = 'memory:';
export const memoryLane = (id: string) => `${MEMORY_LANE}${id}`;
export const PROFILE_LANE = 'profile';
export const TIME_ZONE_NOTE_LANE = 'memory-note';

// ---- Payloads ------------------------------------------------------------------

/** A memory added on the phone. Its row's id is the memory's local id. */
export interface MemoryAddPayload {
    readonly text: string;
    readonly shareable?: boolean;
    /** The check's watermark: the newest `createdAt` (the server's) of the memories the phone held, or null. */
    readonly after: number | null;
    /** The scope's newest Date header as the person wrote, or null. */
    readonly serverAt: number | null;
}

/** The fields a memory edit changes. */
export interface MemoryChange {
    readonly text?: string;
    readonly shareable?: boolean;
}

export interface MemoryUpdatePayload extends MemoryChange {
    /** The memory: its server id, or a local id (resolved through `ids`). */
    readonly memoryId: string;
    /** Each changed field's first base: the stored value the person changed. */
    readonly base: MemoryChange;
}

/** Approve, "Still true" and delete. */
export interface MemoryActionPayload {
    readonly memoryId: string;
}

export interface ProfileSavePayload {
    /** Only the fields this write changes; the rest come fresh from the server as it sends. */
    readonly fields: ProfileFields;
    readonly shareable?: boolean;
    /** Each changed field's first base. */
    readonly base: { readonly fields: ProfileFields; readonly shareable?: boolean };
}

export interface TimeZoneSeenPayload {
    readonly zone: string;
}

/** A write the person can't make: a text out of range, a field too long, a time zone that isn't one. */
export class MemoryWriteError extends RangeError {
    override readonly name = 'MemoryWriteError';
}

/** A memory's text as the server stores it, or null when it isn't 1 to `MEMORY_TEXT_MAX` characters. */
export function memoryText(text: string): string | null {
    const trimmed = text.trim();
    return trimmed.length >= 1 && trimmed.length <= MEMORY_TEXT_MAX ? trimmed : null;
}

function checkedText(text: string): string {
    const trimmed = memoryText(text);
    if (trimmed === null) {
        throw new MemoryWriteError(`A memory has 1 to ${MEMORY_TEXT_MAX.toLocaleString('en')} characters.`);
    }
    return trimmed;
}

/** The newest `createdAt` of the memories a scope holds (its `memories` collection): an add's watermark. */
export function newestMemory(items: Iterable<{ readonly createdAt?: unknown }>): number | null {
    let newest: number | null = null;
    for (const item of items) {
        if (typeof item.createdAt === 'number' && (newest === null || item.createdAt > newest)) {
            newest = item.createdAt;
        }
    }
    return newest;
}

// ---- Writing -------------------------------------------------------------------

type Lanes = Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;
type MemoryOutbox = Pick<
    Outbox,
    'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf' | 'editUnsent' | 'discardUnsent'
>;

export interface MemoryWriteInput {
    /** A fresh UUID (expo-crypto): each row's id and key. */
    readonly newId: () => string;
}

/** Where a write to memory `memoryId` goes, and the create it waits for. */
function route(outbox: Lanes, memoryId: string): { lane: string; dependsOn: string | null } {
    if (isLocalMemory(memoryId)) {
        const pending =
            outbox.resolve(MEMORY_IDS, memoryId) === null &&
            [...outbox.rows(), ...outbox.unsent()].some((write) => write.id === memoryId);
        return { lane: memoryLane(memoryId), dependsOn: pending ? memoryId : null };
    }
    for (const write of [...outbox.rows(), ...outbox.unsent()]) {
        const local = write.lane.startsWith(MEMORY_LANE) ? write.lane.slice(MEMORY_LANE.length) : '';
        if (isLocalMemory(local) && outbox.resolve(MEMORY_IDS, local) === memoryId) {
            return { lane: write.lane, dependsOn: null };
        }
    }
    return { lane: memoryLane(memoryId), dependsOn: null };
}

const parse = <P>(payload: string): P | null => {
    try {
        return JSON.parse(payload) as P;
    } catch {
        return null;
    }
};

/** Lane `lane`'s rows that haven't settled, oldest first. */
const unsettled = (outbox: Pick<Outbox, 'rows'>, lane: string) =>
    outbox.rows().filter((row) => row.lane === lane && row.state !== 'sent');

/**
 * Folds into the lane's newest unsettled row when it is a queued row of
 * `kind` that never went and `fold` gives a new payload, else enqueues a new row. First the
 * lane's refused writes of `replaces` go: the newer intent takes their place
 * (the callers carry over what it should keep), where they would hold it.
 */
async function enqueueOrFold<P>(
    outbox: MemoryOutbox,
    write: { lane: string; dependsOn: string | null; kind: string; payload: P },
    fold: ((queued: P) => P | null) | null,
    newId: () => string,
    replaces: (refused: { kind: string; payload: string }) => boolean = () => false,
): Promise<OutboxRow | 'folded'> {
    for (const refused of outbox.unsent()) {
        if (refused.lane === write.lane && replaces(refused)) {
            await outbox.discardUnsent(refused.id);
        }
    }
    if (fold !== null) {
        // Only into the lane's newest unsettled row, whatever its kind: folding into one
        // behind another write would move this change before it (a save before a clear).
        // Never into one that went before: it may have landed, and the new change's base
        // is its value (`memoryLaneValues`), not its own first base.
        const last = unsettled(outbox, write.lane).at(-1);
        const queued =
            last?.state === 'queued' && last.attempts === 0 && last.kind === write.kind ? parse<P>(last.payload) : null;
        const next = queued === null ? null : fold(queued);
        if (last !== undefined && next !== null) {
            const changed = await outbox.update(
                last.id,
                { payload: JSON.stringify(next), payloadVersion: VERSION },
                outbox.revisionOf(last.id),
            );
            if (changed) {
                return 'folded';
            }
        }
    }
    const row: NewOutboxWrite = {
        id: newId(),
        lane: write.lane,
        kind: write.kind,
        payload: JSON.stringify(write.payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
        ...(write.dependsOn === null ? {} : { dependsOn: write.dependsOn }),
    };
    return outbox.enqueue(row);
}

/** For the same memory: a refused write a newer one of these kinds replaces. */
const sameMemory =
    (memoryId: string, kinds: readonly string[]) =>
    (refused: { kind: string; payload: string }): boolean =>
        kinds.includes(refused.kind) && parse<MemoryActionPayload>(refused.payload)?.memoryId === memoryId;

export interface MemoryAddInput {
    /** The memory's local id (`newLocalMemoryId`). */
    readonly localId: string;
    readonly text: string;
    readonly shareable?: boolean;
    /** A fresh UUID for the row's key. */
    readonly idempotencyKey: string;
    /** `newestMemory` of the scope's memories as the person wrote. */
    readonly after: number | null;
    /** The scope's `serverClock.lastDate()` as the person wrote. */
    readonly serverAt: number | null;
}

/**
 * The outbox row of a memory added on the phone, for `enqueue` or a draft's
 * `enqueueFromDraft` (`memory:new`, Memories' Add box). Throws MemoryWriteError for a text
 * that isn't 1 to `MEMORY_TEXT_MAX` characters once trimmed.
 */
export function memoryAddWrite(input: MemoryAddInput): NewOutboxWrite {
    const payload: MemoryAddPayload = {
        text: checkedText(input.text),
        ...(input.shareable === undefined ? {} : { shareable: input.shareable }),
        after: input.after,
        serverAt: input.serverAt,
    };
    return {
        id: input.localId,
        lane: memoryLane(input.localId),
        kind: MEMORY_ADD_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: input.idempotencyKey,
    };
}

/** Adds a memory: its local id once stored. */
export async function addMemory(
    outbox: Pick<Outbox, 'enqueue'>,
    input: MemoryWriteInput & Omit<MemoryAddInput, 'localId' | 'idempotencyKey'>,
): Promise<string> {
    const localId = newLocalMemoryId(input.newId);
    await outbox.enqueue(memoryAddWrite({ ...input, localId, idempotencyKey: input.newId() }));
    return localId;
}

/** What a change of a memory did: on the phone only (its add hadn't gone), or queued for the server. */
export type MemoryWriteResult = 'in-place' | 'queued';

/** The add row of local memory `memoryId` while it hasn't gone: queued or held, or in `unsent`. */
function pendingAdd(outbox: Pick<Outbox, 'rows' | 'unsent'>, memoryId: string) {
    if (!isLocalMemory(memoryId)) {
        return null;
    }
    const row = outbox
        .rows()
        .find((write) => write.id === memoryId && write.kind === MEMORY_ADD_KIND && write.state !== 'sent');
    if (row !== undefined) {
        return row.state === 'queued' || row.state === 'held' ? { row, refused: null } : null;
    }
    const refused = outbox.unsent().find((write) => write.id === memoryId && write.kind === MEMORY_ADD_KIND);
    return refused === undefined ? null : { row: null, refused };
}

/**
 * Edits a memory's text or sharing. `base` is the stored row's value (never
 * the overlay's); a field the person's own unsettled write sets takes that
 * write's value as its base. A later edit folds into the lane's newest row
 * when that is a queued edit, keeping its bases, and a refused edit's other
 * fields join it. A memory whose add hasn't gone is changed in its add row
 * instead.
 */
export async function editMemory(
    outbox: MemoryOutbox,
    input: MemoryWriteInput & { memoryId: string; change: MemoryChange; base: MemoryChange },
): Promise<MemoryWriteResult> {
    const { memoryId, base, newId } = input;
    const change: MemoryChange = {
        ...(input.change.text === undefined ? {} : { text: checkedText(input.change.text) }),
        ...(input.change.shareable === undefined ? {} : { shareable: input.change.shareable }),
    };
    if (change.text === undefined && change.shareable === undefined) {
        throw new MemoryWriteError('Change the text or the sharing.');
    }
    const add = pendingAdd(outbox, memoryId);
    if (add !== null) {
        const source = add.row ?? add.refused;
        const payload = parse<MemoryAddPayload>(source.payload);
        if (payload !== null) {
            const next = JSON.stringify({ ...payload, ...change });
            const changed =
                add.row !== null
                    ? await outbox.update(
                          add.row.id,
                          { payload: next, payloadVersion: VERSION },
                          outbox.revisionOf(add.row.id),
                      )
                    : await outbox.editUnsent(add.refused.id, { payload: next, payloadVersion: VERSION });
            if (changed) {
                return 'in-place';
            }
        }
    }
    const where = route(outbox, memoryId);
    // Each field's base: what the person's own newest unsettled write sets it to, else the
    // stored value, so an edit behind one in flight never takes the first for a conflict.
    const shown = memoryLaneValues(outbox, where.lane, memoryId);
    const firstBase: MemoryChange = {
        ...(change.text === undefined ? {} : { text: 'text' in shown ? shown.text : base.text }),
        ...(change.shareable === undefined
            ? {}
            : { shareable: 'shareable' in shown ? shown.shareable : base.shareable }),
    };
    // A refused edit of the same memory gives way, but its other fields come along with
    // their bases: a conflicting one conflicts again, and nothing it held is lost.
    let merged: MemoryChange = change;
    let mergedBase: MemoryChange = firstBase;
    for (const refused of outbox.unsent()) {
        const payload = refused.kind === MEMORY_UPDATE_KIND ? parse<MemoryUpdatePayload>(refused.payload) : null;
        if (refused.lane !== where.lane || payload === null || payload.memoryId !== memoryId) {
            continue;
        }
        if (merged.text === undefined && payload.text !== undefined) {
            merged = { ...merged, text: payload.text };
            mergedBase = { ...mergedBase, text: payload.base.text };
        }
        if (merged.shareable === undefined && payload.shareable !== undefined) {
            merged = { ...merged, shareable: payload.shareable };
            mergedBase = { ...mergedBase, shareable: payload.base.shareable };
        }
    }
    await enqueueOrFold<MemoryUpdatePayload>(
        outbox,
        { ...where, kind: MEMORY_UPDATE_KIND, payload: { memoryId, ...merged, base: mergedBase } },
        (queued) =>
            queued.memoryId === memoryId ? { ...queued, ...merged, base: { ...mergedBase, ...queued.base } } : null,
        newId,
        sameMemory(memoryId, [MEMORY_UPDATE_KIND]),
    );
    return 'queued';
}

/**
 * What memory `memoryId`'s newest unsettled writes in `lane` set each field
 * to (its add's, then its edits'): a later edit's base. A field none sets is
 * absent.
 */
function memoryLaneValues(outbox: Pick<Outbox, 'rows'>, lane: string, memoryId: string): MemoryChange {
    let values: MemoryChange = {};
    for (const row of unsettled(outbox, lane)) {
        if (row.kind === MEMORY_ADD_KIND && row.id === memoryId) {
            const payload = parse<MemoryAddPayload>(row.payload);
            if (payload !== null) {
                values = { text: payload.text, shareable: payload.shareable ?? false };
            }
        } else if (row.kind === MEMORY_UPDATE_KIND) {
            const payload = parse<MemoryUpdatePayload>(row.payload);
            if (payload?.memoryId === memoryId) {
                values = {
                    ...values,
                    ...(payload.text === undefined ? {} : { text: payload.text }),
                    ...(payload.shareable === undefined ? {} : { shareable: payload.shareable }),
                };
            }
        }
    }
    return values;
}

/** Approves a socio's proposal. */
export async function approveMemory(outbox: MemoryOutbox, input: MemoryWriteInput & { memoryId: string }) {
    await action(outbox, MEMORY_APPROVE_KIND, input);
}

/** "Still true": the person confirms an active memory. */
export async function confirmMemory(outbox: MemoryOutbox, input: MemoryWriteInput & { memoryId: string }) {
    await action(outbox, MEMORY_CONFIRM_KIND, input);
}

async function action(outbox: MemoryOutbox, kind: string, { memoryId, newId }: MemoryWriteInput & MemoryActionPayload) {
    await enqueueOrFold<MemoryActionPayload>(
        outbox,
        { ...route(outbox, memoryId), kind, payload: { memoryId } },
        // The same again while one waits: nothing more to send.
        (queued) => (queued.memoryId === memoryId ? queued : null),
        newId,
        sameMemory(memoryId, [kind]),
    );
}

/**
 * Deletes a memory or turns a proposal down ("Not now"), after the screen's
 * confirm. A memory whose add hasn't gone is removed with its lane's rows,
 * with no request.
 */
export async function deleteMemory(
    outbox: MemoryOutbox,
    input: MemoryWriteInput & { memoryId: string },
): Promise<MemoryWriteResult> {
    const { memoryId, newId } = input;
    const add = pendingAdd(outbox, memoryId);
    if (add !== null) {
        const lane = memoryLane(memoryId);
        const removed =
            add.row !== null
                ? (await outbox.remove(add.row.id, outbox.revisionOf(add.row.id))) !== null
                : (await outbox.discardUnsent(add.refused.id)) !== null;
        if (removed) {
            for (const row of outbox.rows()) {
                if (row.lane === lane && (row.state === 'queued' || row.state === 'held')) {
                    await outbox.remove(row.id, outbox.revisionOf(row.id));
                }
            }
            for (const refused of outbox.unsent()) {
                if (refused.lane === lane) {
                    await outbox.discardUnsent(refused.id);
                }
            }
            return 'in-place';
        }
    }
    await enqueueOrFold<MemoryActionPayload>(
        outbox,
        { ...route(outbox, memoryId), kind: MEMORY_DELETE_KIND, payload: { memoryId } },
        null,
        newId,
        sameMemory(memoryId, [MEMORY_UPDATE_KIND, MEMORY_CONFIRM_KIND, MEMORY_APPROVE_KIND, MEMORY_DELETE_KIND]),
    );
    return 'queued';
}

/**
 * Keep mine: a memory edit or a profile save refused as `conflict` goes
 * again over what the server now holds (`current`, the stored row), which
 * becomes its base. False when it is gone or changed meanwhile.
 */
export async function keepMine(
    outbox: Pick<Outbox, 'unsent' | 'editUnsent' | 'retryUnsent'>,
    input: {
        id: string;
        current: Pick<MemoryItem, 'text' | 'shareable'> | Pick<UserProfile, 'fields' | 'shareable'> | null;
        newId: () => string;
    },
): Promise<boolean> {
    const refused = outbox.unsent().find((write) => write.id === input.id);
    if (refused === undefined) {
        return false;
    }
    let next: string | null = null;
    if (refused.kind === MEMORY_UPDATE_KIND) {
        const payload = parse<MemoryUpdatePayload>(refused.payload);
        const current = input.current as Pick<MemoryItem, 'text' | 'shareable'> | null;
        if (payload !== null && current !== null && 'text' in current) {
            next = JSON.stringify({
                ...payload,
                base: {
                    ...(payload.text === undefined ? {} : { text: current.text }),
                    ...(payload.shareable === undefined ? {} : { shareable: current.shareable }),
                },
            });
        }
    } else if (refused.kind === PROFILE_SAVE_KIND) {
        const payload = parse<ProfileSavePayload>(refused.payload);
        const current = input.current as Pick<UserProfile, 'fields' | 'shareable'> | null;
        if (payload !== null) {
            next = JSON.stringify({
                ...payload,
                base: {
                    fields: Object.fromEntries(
                        Object.keys(payload.fields).map((field) => [
                            field,
                            current?.fields[field as ProfileField] ?? '',
                        ]),
                    ),
                    ...(payload.shareable === undefined ? {} : { shareable: current?.shareable ?? false }),
                },
            });
        }
    }
    if (next === null || !(await outbox.editUnsent(refused.id, { payload: next, payloadVersion: VERSION }))) {
        return false;
    }
    return outbox.retryUnsent(refused.id, input.newId());
}

/** Keep theirs: the refused write goes; what the server holds stays. */
export async function keepTheirs(outbox: Pick<Outbox, 'discardUnsent'>, id: string): Promise<boolean> {
    return (await outbox.discardUnsent(id)) !== null;
}

/** A profile field's value as the server takes it, or a throw (too long; a time zone that isn't one). */
function checkedField(field: ProfileField, value: string, base: string | undefined): string {
    if (value.length > PROFILE_FIELD_MAX[field]) {
        throw new MemoryWriteError(`${field} has at most ${PROFILE_FIELD_MAX[field]} characters.`);
    }
    const entered = value.trim();
    if (field !== 'timezone' || entered === '' || entered === (base ?? '').trim()) {
        return value;
    }
    const zone = ianaTimeZone(entered);
    if (zone === undefined) {
        throw new MemoryWriteError('Time zone must be a time zone name, like Europe/Madrid or America/New_York.');
    }
    return zone;
}

/**
 * Saves profile fields (and the team-chat sharing). `base` is the stored
 * profile the person changed (null before one exists); a field their own
 * unsettled save or clear sets takes that value as its base. A later save
 * folds into the lane's newest row when that is a queued save, keeping each
 * field's first base, and a refused save's other fields join it.
 */
export async function saveProfile(
    outbox: MemoryOutbox,
    input: MemoryWriteInput & {
        fields: ProfileFields;
        shareable?: boolean;
        base: Pick<UserProfile, 'fields' | 'shareable'> | null;
    },
): Promise<void> {
    // Each field's base: what the person's own newest unsettled save sets it to ('' after a
    // clear), else the stored value, so a save behind theirs never takes it for a conflict.
    const shown = profileLaneValues(outbox);
    const fields: Record<string, string> = {};
    const baseFields: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) {
        const value = input.fields[field];
        if (value !== undefined) {
            const base = shown.fields[field] ?? input.base?.fields[field] ?? '';
            fields[field] = checkedField(field, value, base);
            baseFields[field] = base;
        }
    }
    if (Object.keys(fields).length === 0 && input.shareable === undefined) {
        throw new MemoryWriteError('Change a field or the sharing.');
    }
    let shareable = input.shareable;
    let base: ProfileSavePayload['base'] = {
        fields: baseFields,
        ...(input.shareable === undefined ? {} : { shareable: shown.shareable ?? input.base?.shareable ?? false }),
    };
    // A refused save gives way, but its other fields come along with their bases: a
    // conflicting one conflicts again, and nothing it held is lost. A refused clear goes.
    for (const refused of outbox.unsent()) {
        const payload =
            refused.lane === PROFILE_LANE && refused.kind === PROFILE_SAVE_KIND
                ? parse<ProfileSavePayload>(refused.payload)
                : null;
        if (payload === null) {
            continue;
        }
        for (const [field, value] of Object.entries(payload.fields)) {
            if (fields[field] === undefined && value !== undefined) {
                fields[field] = value;
                base = { ...base, fields: { ...base.fields, [field]: fieldOf(payload.base.fields, field) } };
            }
        }
        if (shareable === undefined && payload.shareable !== undefined) {
            shareable = payload.shareable;
            base = { ...base, shareable: payload.base.shareable ?? false };
        }
    }
    const payload: ProfileSavePayload = {
        fields,
        ...(shareable === undefined ? {} : { shareable }),
        base,
    };
    await enqueueOrFold<ProfileSavePayload>(
        outbox,
        { lane: PROFILE_LANE, dependsOn: null, kind: PROFILE_SAVE_KIND, payload },
        (queued) => ({
            fields: { ...queued.fields, ...fields },
            ...(payload.shareable === undefined && queued.shareable === undefined
                ? {}
                : { shareable: payload.shareable ?? queued.shareable }),
            base: {
                fields: { ...base.fields, ...queued.base.fields },
                ...(base.shareable === undefined && queued.base.shareable === undefined
                    ? {}
                    : { shareable: queued.base.shareable ?? base.shareable }),
            },
        }),
        input.newId,
        (refused) => refused.kind === PROFILE_SAVE_KIND || refused.kind === PROFILE_CLEAR_KIND,
    );
}

/**
 * What the profile lane's newest unsettled writes set each field and the
 * sharing to: a save's values, '' and not shared after a clear. A later
 * save's base; what none sets is absent.
 */
function profileLaneValues(outbox: Pick<Outbox, 'rows'>): {
    fields: Partial<Record<ProfileField, string>>;
    shareable?: boolean;
} {
    let values: { fields: Partial<Record<ProfileField, string>>; shareable?: boolean } = { fields: {} };
    for (const row of unsettled(outbox, PROFILE_LANE)) {
        if (row.kind === PROFILE_CLEAR_KIND) {
            values = { fields: Object.fromEntries(PROFILE_FIELDS.map((field) => [field, ''])), shareable: false };
        } else if (row.kind === PROFILE_SAVE_KIND) {
            const payload = parse<ProfileSavePayload>(row.payload);
            if (payload !== null) {
                const shareable = payload.shareable ?? values.shareable;
                values = {
                    fields: { ...values.fields, ...payload.fields },
                    ...(shareable === undefined ? {} : { shareable }),
                };
            }
        }
    }
    return values;
}

/** Clears the profile (after the screen's confirm): no longer used, every version kept on the server. */
export async function clearProfile(outbox: MemoryOutbox, input: MemoryWriteInput): Promise<void> {
    await enqueueOrFold<Record<string, never>>(
        outbox,
        { lane: PROFILE_LANE, dependsOn: null, kind: PROFILE_CLEAR_KIND, payload: {} },
        (queued) => queued,
        input.newId,
        (refused) => refused.kind === PROFILE_SAVE_KIND || refused.kind === PROFILE_CLEAR_KIND,
    );
}

/** Marks the moved time zone's note seen: the newest zone shown folds into a queued mark. */
export async function markTimeZoneNoteSeen(outbox: MemoryOutbox, input: MemoryWriteInput & TimeZoneSeenPayload) {
    await enqueueOrFold<TimeZoneSeenPayload>(
        outbox,
        { lane: TIME_ZONE_NOTE_LANE, dependsOn: null, kind: TIME_ZONE_SEEN_KIND, payload: { zone: input.zone } },
        () => ({ zone: input.zone }),
        input.newId,
    );
}

// ---- The kinds -----------------------------------------------------------------

export interface MemoryWriteOptions {
    /** cache.db's rows: a confirmed write is handed off there before its row goes. */
    readonly cache?: Pick<SnapshotCache, 'confirm'>;
    /** After a write the server took: what it changed is pulled (`notesForWrite`, the scope's). */
    readonly afterWrite?: (path: string) => void;
}

const MEMORIES_PATH = '/api/memories';
const PROFILE_PATH = `${MEMORIES_PATH}/profile`;
const NOTE_SEEN_PATH = `${MEMORIES_PATH}/time-zone-note/seen`;
const memoryPath = (id: string) => `${MEMORIES_PATH}/${encodeURIComponent(id)}`;

/** A classifier action as a send's outcome. */
function outcome(action: ClassifierAction, answer: Answer): SendOutcome {
    switch (action.action) {
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        default:
            return { action: 'unsent', reason: reasonOf(answer) };
    }
}

async function request(
    context: OutboxContext,
    write: OutboxWrite<unknown>,
    path: string,
    method: WriteMethod,
    special: (answer: Answer) => ClassifierAction | undefined,
    json?: unknown,
): Promise<{ answer: Answer; action: ClassifierAction }> {
    const response = await context.fetch(path, { method, ...(json === undefined ? {} : { json }) });
    const answer = await readAnswer(response, context.signal);
    return { answer, action: classify(answer, { method, ambiguous: write.ambiguous === true, special }) };
}

/** `GET /api/memories` read fresh: an edit's and a save's base, and the add's check. A failure throws (asked again later). */
async function readMemories(context: OutboxContext): Promise<MemoriesState> {
    const response = await context.fetch(MEMORIES_PATH);
    const answer = await readAnswer(response, context.signal);
    const body = answer.body as Partial<MemoriesState> | null;
    if (answer.status !== 200 || body === null || typeof body !== 'object' || !Array.isArray(body.memories)) {
        throw new NetworkError(MEMORIES_PATH);
    }
    return {
        profile: body.profile ?? null,
        memories: body.memories,
        proposals: Array.isArray(body.proposals) ? body.proposals : [],
        ...(typeof body.timeZoneMoved === 'string' ? { timeZoneMoved: body.timeZoneMoved } : {}),
    };
}

const isMemory = (value: unknown): value is MemoryItem =>
    value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';

/** 400: the text or a field the server refused. */
const contentAnswer = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 400 ? { action: 'unsent', reason: MEMORY_REASON.content } : undefined;
/** 404 on a write that changes a memory: it was deleted, or was never the person's. */
const goneAnswer = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 404 || answer.status === 410 ? { action: 'unsent', reason: MEMORY_REASON.gone } : undefined;
/** 404 on approve, "Still true" and delete: nothing left to do. */
const goneIsDone = (answer: Answer): ClassifierAction | undefined =>
    answer.status === 404 || answer.status === 410 ? { action: 'delivered' } : undefined;

const either =
    (...rules: ((answer: Answer) => ClassifierAction | undefined)[]) =>
    (answer: Answer) => {
        for (const rule of rules) {
            const found = rule(answer);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };

/** The add's answers before the outbox's defaults: a proxy's page may come after the server stored it. */
function addAnswer(answer: Answer): ClassifierAction | undefined {
    if (answer.status === 400) {
        return { action: 'unsent', reason: MEMORY_REASON.content };
    }
    if ((answer.status === 502 || answer.status === 504 || answer.status === 503) && answer.code !== 'draining') {
        return { action: 'unknown', reason: 'away' };
    }
    return undefined;
}

function decoder<P>(check: (value: Record<string, unknown>) => boolean, what: string) {
    return (text: string): P => {
        const value = JSON.parse(text) as Record<string, unknown> | null;
        if (!value || typeof value !== 'object' || !check(value)) {
            throw new TypeError(`Not a ${what}.`);
        }
        return value as P;
    };
}

const optional = (value: unknown, type: 'string' | 'boolean') => value === undefined || typeof value === type;
const isFields = (value: unknown) =>
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).every(
        ([field, text]) => (PROFILE_FIELDS as readonly string[]).includes(field) && typeof text === 'string',
    );
const isNumberOrNull = (value: unknown) => value === null || typeof value === 'number';

/** A field's value as compared: an absent field is an empty one. */
const fieldOf = (fields: ProfileFields | undefined, field: string) => fields?.[field as ProfileField] ?? '';

/** The memories and profile writes, over the scope's cache and its pull after a write. */
export function memoryWriteKinds(options: MemoryWriteOptions = {}): OutboxKind<unknown>[] {
    const { cache, afterWrite } = options;

    /** Hands a memory the server answered with to cache.db's `memories`. */
    const handItem = (item: unknown): Pick<Settled, 'handOff'> =>
        cache !== undefined && isMemory(item)
            ? {
                  handOff: () =>
                      cache.confirm({
                          collection: MEMORIES,
                          scope: '',
                          key: item.id,
                          value: item,
                          ...(typeof item.updatedAt === 'number' ? { version: item.updatedAt } : {}),
                      }),
              }
            : {};
    const handProfile = (row: Omit<MemoryProfileRow, 'id'>): Pick<Settled, 'handOff'> =>
        cache === undefined
            ? {}
            : { handOff: () => cache.confirm({ collection: MEMORY_PROFILE, scope: '', key: PROFILE_KEY, value: row }) };

    const add: OutboxKind<MemoryAddPayload> = {
        kind: MEMORY_ADD_KIND,
        payloadVersion: VERSION,
        repeatable: false,
        creates: MEMORY_IDS,
        decode: decoder<MemoryAddPayload>(
            (value) =>
                typeof value.text === 'string' &&
                optional(value.shareable, 'boolean') &&
                isNumberOrNull(value.after) &&
                isNumberOrNull(value.serverAt),
            'memory add',
        ),
        async send(write, context) {
            const { text, shareable } = write.payload;
            const { answer, action } = await request(context, write, MEMORIES_PATH, 'POST', addAnswer, {
                text,
                ...(shareable === undefined ? {} : { shareable }),
            });
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            if (!isMemory(answer.body)) {
                // A 2xx without the memory: the check finds it.
                return { action: 'unknown', reason: `http-${answer.status}` };
            }
            afterWrite?.(MEMORIES_PATH);
            return { action: 'done', serverId: answer.body.id, ...handItem(answer.body) };
        },
        async check({ payload }, context): Promise<CheckOutcome> {
            const state = await readMemories(context);
            const since = serverSince(payload.serverAt);
            const found = state.memories.filter(
                (item) =>
                    isMemory(item) &&
                    item.source === 'person' &&
                    item.dotId === null &&
                    item.text === payload.text &&
                    typeof item.createdAt === 'number' &&
                    (payload.after === null || item.createdAt > payload.after) &&
                    (since === null || item.createdAt >= since) &&
                    !context.claimed(MEMORY_IDS, item.id),
            );
            if (found.length === 1) {
                afterWrite?.(MEMORIES_PATH);
                return { action: 'sent', serverId: found[0]!.id, ...handItem(found[0]) };
            }
            return found.length === 0
                ? { action: 'not-sent' }
                : { action: 'unconfirmed', candidates: found.map((item) => item.id) };
        },
        overlay({ id, payload }, scope): Overlay {
            const key = shownMemoryId(scope.resolve, id);
            return {
                collection: MEMORIES,
                key,
                mode: 'insert',
                value: {
                    id: key,
                    text: payload.text,
                    shareable: payload.shareable ?? false,
                    status: 'active',
                    source: 'person',
                    dotId: null,
                    threadId: null,
                },
            };
        },
    };

    const update: OutboxKind<MemoryUpdatePayload> = {
        kind: MEMORY_UPDATE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<MemoryUpdatePayload>(
            (value) =>
                typeof value.memoryId === 'string' &&
                optional(value.text, 'string') &&
                optional(value.shareable, 'boolean') &&
                (value.text !== undefined || value.shareable !== undefined) &&
                value.base !== null &&
                typeof value.base === 'object',
            'memory update',
        ),
        async send(write, context) {
            const { text, shareable, base } = write.payload;
            const id = serverMemoryId(context.resolve, write.payload.memoryId);
            if (id === null) {
                return { action: 'unsent', reason: MEMORY_REASON.noMemory };
            }
            // The version check, on a fresh read.
            const state = await readMemories(context);
            const current = [...state.memories, ...state.proposals].find((item) => isMemory(item) && item.id === id);
            if (current === undefined) {
                return { action: 'unsent', reason: MEMORY_REASON.gone };
            }
            const moved = <V>(mine: V | undefined, was: V | undefined, now: V) =>
                mine !== undefined && was !== undefined && now !== was && now !== mine;
            if (moved(text, base.text, current.text) || moved(shareable, base.shareable, current.shareable)) {
                return { action: 'unsent', reason: MEMORY_REASON.conflict };
            }
            if ((text ?? current.text) === current.text && (shareable ?? current.shareable) === current.shareable) {
                // Already as written: an earlier attempt landed.
                return { action: 'done', ...handItem(current) };
            }
            const path = memoryPath(id);
            const { answer, action } = await request(context, write, path, 'PUT', either(contentAnswer, goneAnswer), {
                ...(text === undefined ? {} : { text }),
                ...(shareable === undefined ? {} : { shareable }),
            });
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            afterWrite?.(path);
            return { action: 'done', ...handItem(answer.body) };
        },
        overlay({ payload }, scope): Overlay {
            const { memoryId, base: _base, ...change } = payload;
            return { collection: MEMORIES, key: shownMemoryId(scope.resolve, memoryId), mode: 'patch', value: change };
        },
    };

    const memoryAction = (
        kind: string,
        method: WriteMethod,
        path: (id: string) => string,
        view: Record<string, unknown>,
        deletes: boolean,
    ): OutboxKind<MemoryActionPayload> => ({
        kind,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<MemoryActionPayload>((value) => typeof value.memoryId === 'string', kind),
        async send(write, context) {
            const id = serverMemoryId(context.resolve, write.payload.memoryId);
            if (id === null) {
                // Never created: nothing on the server to approve, confirm or delete.
                return { action: 'done' };
            }
            const target = path(id);
            const { answer, action } = await request(context, write, target, method, goneIsDone);
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            afterWrite?.(target);
            if (deletes) {
                return {
                    action: 'done',
                    ...(cache === undefined
                        ? {}
                        : {
                              handOff: () => cache.confirm({ collection: MEMORIES, scope: '', key: id, deleted: true }),
                          }),
                };
            }
            return { action: 'done', ...(answer.status >= 200 && answer.status < 300 ? handItem(answer.body) : {}) };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: MEMORIES,
                key: shownMemoryId(scope.resolve, payload.memoryId),
                mode: 'patch',
                value: view,
            };
        },
    });

    const approve = memoryAction(
        MEMORY_APPROVE_KIND,
        'POST',
        (id) => `${memoryPath(id)}/approve`,
        { status: 'active' },
        false,
    );
    const confirm = memoryAction(MEMORY_CONFIRM_KIND, 'POST', (id) => `${memoryPath(id)}/confirm`, {}, false);
    const remove = memoryAction(MEMORY_DELETE_KIND, 'DELETE', memoryPath, { deleted: true }, true);

    const save: OutboxKind<ProfileSavePayload> = {
        kind: PROFILE_SAVE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<ProfileSavePayload>(
            (value) =>
                isFields(value.fields) &&
                optional(value.shareable, 'boolean') &&
                value.base !== null &&
                typeof value.base === 'object' &&
                isFields((value.base as { fields?: unknown }).fields),
            'profile save',
        ),
        async send(write, context) {
            const { fields, shareable, base } = write.payload;
            const state = await readMemories(context);
            const fresh = state.profile?.fields ?? {};
            const freshShareable = state.profile?.shareable ?? false;
            for (const field of Object.keys(fields)) {
                const now = fieldOf(fresh, field);
                if (now !== fieldOf(base.fields, field) && now !== fieldOf(fields, field)) {
                    return { action: 'unsent', reason: MEMORY_REASON.conflict };
                }
            }
            if (
                shareable !== undefined &&
                base.shareable !== undefined &&
                freshShareable !== base.shareable &&
                freshShareable !== shareable
            ) {
                return { action: 'unsent', reason: MEMORY_REASON.conflict };
            }
            // The whole profile: `profiles.save` keeps exactly the fields sent.
            const whole: Record<string, string> = {};
            for (const field of PROFILE_FIELDS) {
                const value = fields[field] ?? fresh[field];
                if (value !== undefined) {
                    whole[field] = value;
                }
            }
            const { answer, action } = await request(context, write, PROFILE_PATH, 'PUT', contentAnswer, {
                fields: whole,
                shareable: shareable ?? freshShareable,
            });
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            afterWrite?.(PROFILE_PATH);
            const saved = answer.body;
            return {
                action: 'done',
                ...(saved !== null && typeof saved === 'object'
                    ? handProfile({ profile: saved as UserProfile, timeZoneMoved: state.timeZoneMoved ?? null })
                    : {}),
            };
        },
        overlay({ payload }): Overlay {
            return {
                collection: MEMORY_PROFILE,
                key: PROFILE_KEY,
                mode: 'patch',
                value: {
                    fields: payload.fields,
                    ...(payload.shareable === undefined ? {} : { shareable: payload.shareable }),
                },
            };
        },
    };

    const clear: OutboxKind<Record<string, never>> = {
        kind: PROFILE_CLEAR_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<Record<string, never>>(() => true, 'profile clear'),
        async send(write, context) {
            const { answer, action } = await request(context, write, PROFILE_PATH, 'DELETE', goneIsDone);
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            afterWrite?.(PROFILE_PATH);
            return { action: 'done', ...handProfile({ profile: null, timeZoneMoved: null }) };
        },
        overlay(): Overlay {
            return { collection: MEMORY_PROFILE, key: PROFILE_KEY, mode: 'patch', value: { cleared: true } };
        },
    };

    const seen: OutboxKind<TimeZoneSeenPayload> = {
        kind: TIME_ZONE_SEEN_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<TimeZoneSeenPayload>((value) => typeof value.zone === 'string', 'time zone note'),
        async send(write, context) {
            const state = await readMemories(context);
            if (state.timeZoneMoved !== write.payload.zone) {
                // Stale: the zone moved again, or the note was marked elsewhere.
                return { action: 'done' };
            }
            const { answer, action } = await request(context, write, NOTE_SEEN_PATH, 'POST', () => undefined, {
                zone: write.payload.zone,
            });
            if (action.action === 'unsent') {
                // Nothing for the person to do about a mark.
                return { action: 'done' };
            }
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            return { action: 'done', ...handProfile({ profile: state.profile, timeZoneMoved: null }) };
        },
    };

    return [add, update, approve, confirm, remove, save, clear, seen] as OutboxKind<unknown>[];
}

/** How these kinds' rows look on screen (`overlaysOf`), without anything that sends: Memories lays them over. */
export const MEMORY_WRITE_VIEWS: readonly OverlayKind<unknown>[] = memoryWriteKinds();

// ---- The view ------------------------------------------------------------------

/** A memory as Memories shows it: the stored row with its overlays, and where its newest write stands. */
export interface ShownMemory extends MemoryItem {
    /** The newest write's state over it, or null when none waits. */
    readonly pending: OverlayItem['state'] | null;
    /** The newest write's id: the Unsent row's, for Keep mine and Keep theirs. */
    readonly writeId: string | null;
    readonly reason: string | null;
}

export interface ShownMemories {
    /** Active memories, newest first. */
    readonly memories: readonly ShownMemory[];
    /** Proposals waiting, newest first. */
    readonly proposals: readonly ShownMemory[];
    /** The profile with the queued saves on top; null when none or cleared. */
    readonly profile: UserProfile | null;
    readonly profilePending: OverlayItem['state'] | null;
    readonly timeZoneMoved: string | null;
}

/**
 * Memories' rows with the outbox laid over (these kinds' overlays): an added memory
 * shows at once, an edit's text, an approval's status, a delete hides it, a
 * save's fields show on the profile. `overlays` are `overlaysOf` with
 * `MEMORY_WRITE_VIEWS`, oldest first.
 */
export function shownMemories(
    rows: Iterable<MemoryItem>,
    profileRow: MemoryProfileRow | null | undefined,
    overlays: readonly OverlayItem[],
): ShownMemories {
    const byId = new Map<string, ShownMemory>();
    const deleted = new Set<string>();
    for (const row of rows) {
        byId.set(row.id, { ...row, pending: null, writeId: null, reason: null });
    }
    let profile: UserProfile | null = profileRow?.profile ?? null;
    let profilePending: OverlayItem['state'] | null = null;
    for (const overlay of overlays) {
        const marks = { pending: overlay.state, writeId: overlay.id, reason: overlay.reason };
        if (overlay.collection === MEMORY_PROFILE) {
            const value = overlay.value as { fields?: ProfileFields; shareable?: boolean; cleared?: true };
            profile =
                value.cleared === true
                    ? null
                    : {
                          fields: { ...profile?.fields, ...value.fields },
                          shareable: value.shareable ?? profile?.shareable ?? false,
                          updatedAt: profile?.updatedAt ?? overlay.createdAt,
                      };
            profilePending = overlay.state;
            continue;
        }
        if (overlay.collection !== MEMORIES) {
            continue;
        }
        const stored = byId.get(overlay.key);
        if (overlay.mode === 'insert') {
            byId.set(overlay.key, {
                ...(overlay.value as MemoryItem),
                createdAt: overlay.createdAt,
                updatedAt: overlay.createdAt,
                confirmedAt: overlay.createdAt,
                ...stored,
                ...marks,
            });
            continue;
        }
        if (stored === undefined) {
            continue;
        }
        const value = overlay.value as Partial<MemoryItem> & { deleted?: true };
        if (value.deleted === true && overlay.state !== 'unsent') {
            deleted.add(overlay.key);
        }
        const { deleted: _deleted, ...change } = value;
        byId.set(overlay.key, { ...stored, ...(overlay.state === 'unsent' ? {} : change), ...marks });
    }
    const shown = [...byId.values()].filter((item) => !deleted.has(item.id));
    const newest = (a: ShownMemory, b: ShownMemory) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);
    return {
        memories: shown.filter((item) => item.status === 'active').sort(newest),
        proposals: shown.filter((item) => item.status === 'proposed').sort(newest),
        profile,
        profilePending,
        timeZoneMoved: profileRow?.timeZoneMoved ?? null,
    };
}
