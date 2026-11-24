import { afterEach, describe, expect, it } from 'vitest';

import { unsentListRows } from '../../src/shell/unsent';
import { MEMORIES, MEMORY_PROFILE, type MemoryProfileRow } from '../../src/sync/memories';
import {
    addMemory,
    approveMemory,
    clearProfile,
    confirmMemory,
    deleteMemory,
    editMemory,
    isLocalMemory,
    keepMine,
    keepTheirs,
    markTimeZoneNoteSeen,
    MEMORY_ADD_KIND,
    MEMORY_IDS,
    MEMORY_REASON,
    MEMORY_WRITE_VIEWS,
    MemoryWriteError,
    newestMemory,
    saveProfile,
    shownMemories,
} from '../../src/sync/memory-writes';
import { overlaysOf } from '../../src/sync/outbox-overlay';

import { closePhones, open, type Phone, type Server, server } from './memory-fakes';
import { turns } from './outbox-fakes';

// Memories and profile writes on a
// real outbox (user.db on node:sqlite) against a fake server whose routes
// answer as src/server/memory/routes.ts does: statuses only, never text.

afterEach(closePhones);

let ids = 0;
const newId = () => `id-${++ids}`;

const empty = (phone: Phone) => phone.outbox.rows().length === 0;
const add = (phone: Phone, srv: Server, text: string, serverAt: number | null = srv.now()) =>
    addMemory(phone.outbox, { text, newId, after: newestMemory(srv.stored()), serverAt });

describe('adding a memory', () => {
    it('posts the trimmed text, records the server id and hands the memory to cache.db', async () => {
        const srv = server();
        const phone = await open(srv);
        const localId = await add(phone, srv, '  I take the train on Tuesdays  ');
        expect(isLocalMemory(localId)).toBe(true);
        expect(localId.startsWith('local-')).toBe(false);
        await phone.until(() => empty(phone));
        const [stored] = srv.stored();
        expect(stored!.text).toBe('I take the train on Tuesdays');
        expect(phone.outbox.resolve(MEMORY_IDS, localId)).toBe(stored!.id);
        expect(phone.confirmed).toEqual([
            expect.objectContaining({ collection: MEMORIES, key: stored!.id, version: stored!.updatedAt }),
        ]);
        expect(phone.pulled).toContain('/api/memories');
    });

    it('refuses an empty or too long text before queuing', async () => {
        const srv = server();
        const phone = await open(srv);
        await expect(add(phone, srv, '   ')).rejects.toThrow(MemoryWriteError);
        await expect(add(phone, srv, 'x'.repeat(2001))).rejects.toThrow(MemoryWriteError);
        expect(phone.outbox.rows()).toHaveLength(0);
    });

    it('an answer lost after the server stored it: the check finds it, and it never goes twice', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', 'drop');
        const localId = await add(phone, srv, 'Coffee, no sugar');
        await phone.until(() => empty(phone));
        expect(srv.stored()).toHaveLength(1);
        expect(srv.count('POST /api/memories')).toBe(1);
        expect(phone.outbox.resolve(MEMORY_IDS, localId)).toBe(srv.stored()[0]!.id);
    });

    it('a kill with the add in flight: after the relaunch exactly one memory', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', 'hang');
        const localId = await add(phone, srv, 'Kill me once');
        await turns(30);
        expect(srv.stored()).toHaveLength(1);
        const after = await phone.relaunch();
        await after.until(() => empty(after));
        expect(srv.stored()).toHaveLength(1);
        expect(srv.count('POST /api/memories')).toBe(1);
        expect(after.outbox.resolve(MEMORY_IDS, localId)).toBe(srv.stored()[0]!.id);
    });

    it('a request that never arrived goes again after the check finds nothing', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', { status: 500 });
        await add(phone, srv, 'Second try');
        await phone.until(() => empty(phone));
        expect(srv.stored()).toHaveLength(1);
        expect(srv.count('POST /api/memories')).toBe(2);
    });

    it('two identical memories queued, the first lost after storing: each settles on its own memory', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', 'drop');
        const first = await add(phone, srv, 'Same words');
        const second = await add(phone, srv, 'Same words');
        await phone.until(() => empty(phone));
        const stored = srv.stored();
        expect(stored).toHaveLength(2);
        const firstId = phone.outbox.resolve(MEMORY_IDS, first);
        const secondId = phone.outbox.resolve(MEMORY_IDS, second);
        expect(new Set([firstId, secondId])).toEqual(new Set(stored.map((item) => item.id)));
    });

    it('two candidates the phone can’t tell apart wait for the person, with both for View', async () => {
        const srv = server();
        const phone = await open(srv);
        const at = srv.now();
        srv.script('POST memories', 'drop');
        await add(phone, srv, 'Twice', at);
        // Someone added the same words on the web at the same moment.
        srv.memory({ text: 'Twice' });
        await phone.until(() => phone.outbox.holds().length === 1);
        const [group] = phone.outbox.holds();
        expect(group!.root.cause).toBe('unconfirmed');
        expect(group!.root.candidates).toHaveLength(2);
    });

    it('an older memory of the same words, before the watermark, is not a candidate', async () => {
        const srv = server();
        srv.memory({ text: 'Old words' });
        const phone = await open(srv);
        srv.script('POST memories', 'offline');
        await add(phone, srv, 'Old words');
        await phone.until(() => empty(phone));
        expect(srv.stored().filter((item) => item.text === 'Old words')).toHaveLength(2);
    });

    it('a 400 goes to unsent, with the Unsent list’s words and the text to copy', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', { status: 400 });
        await add(phone, srv, 'Refused');
        await phone.until(() => phone.outbox.unsent().length === 1);
        const [row] = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(row).toMatchObject({
            what: 'New memory',
            where: 'Memories',
            text: 'Refused',
            why: 'It couldn’t be sent as written',
        });
    });
});

describe('editing a memory', () => {
    it('sends only the changed field and hands the answer off', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Old' });
        const phone = await open(srv);
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: ' New ' }, base: { text: 'Old' }, newId });
        await phone.until(() => empty(phone));
        expect(srv.items.get(item.id)!.text).toBe('New');
        expect(phone.confirmed.at(-1)).toMatchObject({ collection: MEMORIES, key: item.id });
    });

    it('a memory edited on the server before a queued edit goes to unsent; Keep mine sends it, Keep theirs drops it', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Mine before' });
        const phone = await open(srv);
        srv.items.get(item.id)!.text = 'Changed on the web';
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { text: 'Mine after' },
            base: { text: 'Mine before' },
            newId,
        });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe(MEMORY_REASON.conflict);
        expect(srv.count(`PUT /api/memories/${item.id}`)).toBe(0);
        expect(
            await keepMine(phone.outbox, { id: phone.outbox.unsent()[0]!.id, current: srv.items.get(item.id)!, newId }),
        ).toBe(true);
        await phone.until(() => empty(phone) && phone.outbox.unsent().length === 0);
        expect(srv.items.get(item.id)!.text).toBe('Mine after');

        srv.items.get(item.id)!.text = 'Theirs again';
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { text: 'Lost' },
            base: { text: 'Mine after' },
            newId,
        });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(await keepTheirs(phone.outbox, phone.outbox.unsent()[0]!.id)).toBe(true);
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.items.get(item.id)!.text).toBe('Theirs again');
    });

    it('two edits fold into one row and keep the first base', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Base' });
        const phone = await open(srv);
        await phone.outbox.interrupt({ pause: true });
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: 'One' }, base: { text: 'Base' }, newId });
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: 'Two' }, base: { text: 'One' }, newId });
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { shareable: true },
            base: { shareable: false },
            newId,
        });
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toEqual({
            memoryId: item.id,
            text: 'Two',
            shareable: true,
            base: { text: 'Base', shareable: false },
        });
        phone.outbox.unpause();
        await phone.until(() => empty(phone));
        expect(srv.items.get(item.id)).toMatchObject({ text: 'Two', shareable: true });
        expect(srv.count(`PUT /api/memories/${item.id}`)).toBe(1);
    });

    it('an edit behind one whose answer was lost takes it as its base, in a row of its own: both land, no conflict', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Base' });
        const phone = await open(srv);
        srv.script('PUT memory', 'drop');
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: 'One' }, base: { text: 'Base' }, newId });
        await phone.settle();
        // It went and may have landed: never folded into.
        expect(phone.outbox.rows()[0]!.attempts).toBe(1);
        // The screen still holds the stored row.
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: 'Two' }, base: { text: 'Base' }, newId });
        expect(phone.outbox.rows()).toHaveLength(2);
        expect(JSON.parse(phone.outbox.rows()[1]!.payload)).toMatchObject({ text: 'Two', base: { text: 'One' } });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.items.get(item.id)!.text).toBe('Two');
    });

    it('a new edit carries a refused edit’s other field, which still conflicts and can be copied', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Before', shareable: false });
        const phone = await open(srv);
        srv.items.get(item.id)!.text = 'Changed on the web';
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { text: 'Mine' },
            base: { text: 'Before' },
            newId,
        });
        await phone.until(() => phone.outbox.unsent().length === 1);
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { shareable: true },
            base: { shareable: false },
            newId,
        });
        await phone.until(() => phone.outbox.unsent().length === 1 && empty(phone));
        const [refused] = phone.outbox.unsent();
        expect(refused!.reason).toBe(MEMORY_REASON.conflict);
        expect(JSON.parse(refused!.payload)).toMatchObject({
            text: 'Mine',
            shareable: true,
            base: { text: 'Before', shareable: false },
        });
        const [row] = unsentListRows(phone.outbox.unsent(), [], { chatTitle: () => null, resolve: () => null });
        expect(row!.text).toContain('Mine');
        await keepMine(phone.outbox, { id: refused!.id, current: srv.items.get(item.id)!, newId });
        await phone.until(() => empty(phone) && phone.outbox.unsent().length === 0);
        expect(srv.items.get(item.id)).toMatchObject({ text: 'Mine', shareable: true });
    });

    it('an edit already applied by a lost attempt is done without a second PUT', async () => {
        const srv = server();
        const item = srv.memory({ text: 'Before' });
        const phone = await open(srv);
        srv.script('PUT memory', 'drop');
        await editMemory(phone.outbox, {
            memoryId: item.id,
            change: { text: 'After' },
            base: { text: 'Before' },
            newId,
        });
        await phone.until(() => empty(phone));
        expect(srv.items.get(item.id)!.text).toBe('After');
        expect(srv.count(`PUT /api/memories/${item.id}`)).toBe(1);
        expect(phone.outbox.unsent()).toHaveLength(0);
    });

    it('a deleted memory’s edit goes to unsent as deleted', async () => {
        const srv = server();
        const item = srv.memory();
        const phone = await open(srv);
        srv.items.get(item.id)!.deleted = true;
        await editMemory(phone.outbox, { memoryId: item.id, change: { text: 'x' }, base: { text: item.text }, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe(MEMORY_REASON.gone);
    });

    it('an edit of a memory whose add hasn’t gone changes the add in place', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', { status: 503, body: { code: 'draining' } });
        const localId = await add(phone, srv, 'Draft words');
        await phone.settle();
        expect(
            await editMemory(phone.outbox, {
                memoryId: localId,
                change: { text: 'Better words' },
                base: {},
                newId,
            }),
        ).toBe('in-place');
        expect(phone.outbox.rows()).toHaveLength(1);
        await phone.until(() => empty(phone));
        expect(srv.stored().map((item) => item.text)).toEqual(['Better words']);
    });

    it('an edit of a memory whose add is in flight waits for it, then goes under the server id', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', 'drop');
        const localId = await add(phone, srv, 'First');
        await turns(5);
        await editMemory(phone.outbox, {
            memoryId: localId,
            change: { text: 'Second' },
            base: { text: 'First' },
            newId,
        });
        await phone.until(() => empty(phone));
        expect(srv.stored()).toHaveLength(1);
        expect(srv.stored()[0]!.text).toBe('Second');
    });
});

describe('approve, still true and delete', () => {
    it('approves a proposal and hands the active memory off', async () => {
        const srv = server();
        const proposal = srv.memory({ status: 'proposed', source: 'socio', dotId: 'dot-1', confirmedAt: null });
        const phone = await open(srv);
        await approveMemory(phone.outbox, { memoryId: proposal.id, newId });
        await approveMemory(phone.outbox, { memoryId: proposal.id, newId });
        await phone.until(() => empty(phone));
        expect(srv.items.get(proposal.id)!.status).toBe('active');
        expect(phone.confirmed.at(-1)).toMatchObject({
            key: proposal.id,
            value: expect.objectContaining({ status: 'active' }),
        });
    });

    it('a 404 is done for approve, still true and delete', async () => {
        const srv = server();
        const phone = await open(srv);
        await approveMemory(phone.outbox, { memoryId: 'gone-1', newId });
        await confirmMemory(phone.outbox, { memoryId: 'gone-2', newId });
        await deleteMemory(phone.outbox, { memoryId: 'gone-3', newId });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
    });

    it('still true and delete go in order, and the delete reaches cache.db', async () => {
        const srv = server();
        const item = srv.memory();
        const phone = await open(srv);
        await confirmMemory(phone.outbox, { memoryId: item.id, newId });
        await deleteMemory(phone.outbox, { memoryId: item.id, newId });
        await phone.until(() => empty(phone));
        expect(srv.log.filter((line) => !line.startsWith('GET'))).toEqual([
            `POST /api/memories/${item.id}/confirm`,
            `DELETE /api/memories/${item.id}`,
        ]);
        expect(phone.confirmed.at(-1)).toEqual({ collection: MEMORIES, scope: '', key: item.id, deleted: true });
    });

    it('deleting a memory whose add hasn’t gone removes its rows with no request', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', { status: 503, body: { code: 'draining' } });
        const localId = await add(phone, srv, 'Never mind');
        await phone.settle();
        await editMemory(phone.outbox, { memoryId: localId, change: { shareable: true }, base: {}, newId });
        expect(await deleteMemory(phone.outbox, { memoryId: localId, newId })).toBe('in-place');
        expect(phone.outbox.rows()).toHaveLength(0);
        await phone.settle();
        expect(srv.stored()).toHaveLength(0);
    });
});

describe('the profile', () => {
    it('changing one field keeps the others the server holds', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam', role: 'Ops' }, shareable: true, updatedAt: 1 };
        const phone = await open(srv);
        const shown = { fields: { name: 'Sam', role: 'Ops' }, shareable: true };
        // The web adds a field after the phone last read the profile.
        srv.profile = { fields: { name: 'Sam', role: 'Ops', language: 'Spanish' }, shareable: true, updatedAt: 2 };
        await saveProfile(phone.outbox, { fields: { role: 'Ops and finance' }, base: shown, newId });
        await phone.until(() => empty(phone));
        expect(srv.profile).toMatchObject({
            fields: { name: 'Sam', role: 'Ops and finance', language: 'Spanish' },
            shareable: true,
        });
        expect(phone.confirmed.at(-1)).toMatchObject({
            collection: MEMORY_PROFILE,
            key: 'profile',
            value: {
                profile: expect.objectContaining({ fields: expect.objectContaining({ role: 'Ops and finance' }) }),
            },
        });
    });

    it('a field changed on the server first goes to unsent; Keep mine sends it over theirs', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam' }, shareable: false, updatedAt: 1 };
        const phone = await open(srv);
        const shown = srv.profile;
        srv.profile = { fields: { name: 'Samuel' }, shareable: false, updatedAt: 2 };
        await saveProfile(phone.outbox, { fields: { name: 'Sammy' }, base: shown, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe(MEMORY_REASON.conflict);
        const [row] = unsentListRows(phone.outbox.unsent(), [], { chatTitle: () => null, resolve: () => null });
        expect(row).toMatchObject({ what: 'Profile', where: 'Your profile', text: 'Preferred name: Sammy' });
        await keepMine(phone.outbox, { id: phone.outbox.unsent()[0]!.id, current: srv.profile, newId });
        await phone.until(() => empty(phone) && phone.outbox.unsent().length === 0);
        expect(srv.profile!.fields.name).toBe('Sammy');
    });

    it('saves fold, keeping each field’s first base', async () => {
        const srv = server();
        const phone = await open(srv);
        await phone.outbox.interrupt({ pause: true });
        await saveProfile(phone.outbox, { fields: { name: 'A' }, base: null, newId });
        await saveProfile(phone.outbox, {
            fields: { name: 'B', pronouns: 'they' },
            shareable: true,
            base: { fields: { name: 'A' }, shareable: false },
            newId,
        });
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toEqual({
            fields: { name: 'B', pronouns: 'they' },
            shareable: true,
            base: { fields: { name: '', pronouns: '' }, shareable: false },
        });
        phone.outbox.unpause();
        await phone.until(() => empty(phone));
        expect(srv.profile).toMatchObject({ fields: { name: 'B', pronouns: 'they' }, shareable: true });
    });

    it('save, clear, save while the first waits: the second save goes after the clear', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('GET memories', { status: 503, body: { code: 'draining' } });
        await saveProfile(phone.outbox, { fields: { pronouns: 'they' }, base: null, newId });
        await phone.settle();
        await clearProfile(phone.outbox, { newId });
        await saveProfile(phone.outbox, { fields: { name: 'Sam' }, base: null, newId });
        expect(phone.outbox.rows().map((row) => row.kind)).toEqual(['profile-save', 'profile-clear', 'profile-save']);
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: MEMORY_WRITE_VIEWS, scope: phone.outbox });
        expect(shownMemories([], null, overlays).profile?.fields).toEqual({ name: 'Sam' });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.profile?.fields).toEqual({ name: 'Sam' });
    });

    it('clear, save, clear while the first waits: the profile ends cleared', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam' }, shareable: false, updatedAt: 1 };
        const phone = await open(srv);
        srv.script('DELETE profile', { status: 503, body: { code: 'draining' } });
        await clearProfile(phone.outbox, { newId });
        await phone.settle();
        await saveProfile(phone.outbox, { fields: { role: 'Ops' }, base: srv.profile, newId });
        await clearProfile(phone.outbox, { newId });
        expect(phone.outbox.rows().map((row) => row.kind)).toEqual(['profile-clear', 'profile-save', 'profile-clear']);
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.profile).toBeNull();
    });

    it('a save behind a queued clear takes empty fields as its base: no conflict', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam', role: 'Ops' }, shareable: true, updatedAt: 1 };
        const phone = await open(srv);
        const shown = srv.profile;
        srv.script('DELETE profile', { status: 503, body: { code: 'draining' } });
        await clearProfile(phone.outbox, { newId });
        await phone.settle();
        await saveProfile(phone.outbox, { fields: { role: 'Lead' }, shareable: true, base: shown, newId });
        expect(JSON.parse(phone.outbox.rows()[1]!.payload)).toMatchObject({
            base: { fields: { role: '' }, shareable: false },
        });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.profile).toMatchObject({ fields: { role: 'Lead' }, shareable: true });
    });

    it('a new save carries a refused save’s other fields: the role survives a conflict on pronouns', async () => {
        const srv = server();
        srv.profile = { fields: { pronouns: 'he', role: 'Ops' }, shareable: false, updatedAt: 1 };
        const phone = await open(srv);
        const shown = srv.profile;
        srv.profile = { fields: { pronouns: 'she', role: 'Ops' }, shareable: false, updatedAt: 2 };
        await saveProfile(phone.outbox, { fields: { pronouns: 'they', role: 'Lead' }, base: shown, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        await saveProfile(phone.outbox, { fields: { name: 'Sam' }, base: srv.profile, newId });
        await phone.until(() => phone.outbox.unsent().length === 1 && empty(phone));
        const [refused] = phone.outbox.unsent();
        expect(refused!.reason).toBe(MEMORY_REASON.conflict);
        expect(JSON.parse(refused!.payload)).toMatchObject({
            fields: { name: 'Sam', pronouns: 'they', role: 'Lead' },
            base: { fields: { name: '', pronouns: 'he', role: 'Ops' } },
        });
        await keepMine(phone.outbox, { id: refused!.id, current: srv.profile, newId });
        await phone.until(() => empty(phone) && phone.outbox.unsent().length === 0);
        expect(srv.profile?.fields).toEqual({ name: 'Sam', pronouns: 'they', role: 'Lead' });
    });

    it('checks a time zone before queuing, and sends the database’s spelling', async () => {
        const srv = server();
        const phone = await open(srv);
        await expect(
            saveProfile(phone.outbox, { fields: { timezone: 'Mars/Olympus_Mons' }, base: null, newId }),
        ).rejects.toThrow(MemoryWriteError);
        await expect(
            saveProfile(phone.outbox, { fields: { name: 'x'.repeat(81) }, base: null, newId }),
        ).rejects.toThrow(MemoryWriteError);
        expect(phone.outbox.rows()).toHaveLength(0);
        await saveProfile(phone.outbox, { fields: { timezone: 'europe/madrid' }, base: null, newId });
        await phone.until(() => empty(phone));
        expect(srv.profile!.fields.timezone).toBe('Europe/Madrid');
    });

    it('clears the profile', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam' }, shareable: false, updatedAt: 1 };
        const phone = await open(srv);
        await clearProfile(phone.outbox, { newId });
        await phone.until(() => empty(phone));
        expect(srv.profile).toBeNull();
        expect(phone.confirmed.at(-1)).toMatchObject({ value: { profile: null } });
    });
});

describe('the moved time zone’s note', () => {
    it('marks the zone shown, and drops a stale mark without a request', async () => {
        const srv = server();
        srv.moveTimeZone('Europe/Lisbon');
        const phone = await open(srv);
        await markTimeZoneNoteSeen(phone.outbox, { zone: 'Europe/Lisbon', newId });
        await phone.until(() => empty(phone));
        expect(srv.count('POST /api/memories/time-zone-note/seen')).toBe(1);

        srv.moveTimeZone('Asia/Tokyo');
        await markTimeZoneNoteSeen(phone.outbox, { zone: 'Europe/Lisbon', newId });
        await phone.until(() => empty(phone));
        expect(srv.count('POST /api/memories/time-zone-note/seen')).toBe(1);
        expect(phone.outbox.unsent()).toHaveLength(0);
    });
});

describe('overlays', () => {
    it('Memories shows each write at once over the stored rows', async () => {
        const srv = server();
        const kept = srv.memory({ text: 'Kept' });
        const edited = srv.memory({ text: 'Before' });
        const gone = srv.memory({ text: 'Gone' });
        const proposal = srv.memory({ status: 'proposed', source: 'socio', dotId: 'dot-1', confirmedAt: null });
        const phone = await open(srv);
        srv.script('POST memories', { status: 503, body: { code: 'draining' } });
        srv.script('GET memories', ...Array.from({ length: 20 }, () => ({ status: 503, body: { code: 'draining' } })));
        await add(phone, srv, 'Brand new');
        await editMemory(phone.outbox, {
            memoryId: edited.id,
            change: { text: 'After' },
            base: { text: 'Before' },
            newId,
        });
        await deleteMemory(phone.outbox, { memoryId: gone.id, newId });
        await approveMemory(phone.outbox, { memoryId: proposal.id, newId });
        await saveProfile(phone.outbox, { fields: { name: 'Sam' }, base: null, newId });
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: MEMORY_WRITE_VIEWS, scope: phone.outbox });
        const profileRow: MemoryProfileRow = { id: 'profile', profile: null, timeZoneMoved: null };
        const shown = shownMemories(srv.stored(), profileRow, overlays);
        expect(shown.memories.map((item) => item.text).sort()).toEqual(
            ['After', 'Brand new', 'Kept', 'A memory'].sort(),
        );
        expect(shown.memories.find((item) => item.id === kept.id)!.pending).toBeNull();
        expect(shown.memories.find((item) => item.text === 'Brand new')!.pending).not.toBeNull();
        expect(shown.proposals).toHaveLength(0);
        expect(shown.profile?.fields).toEqual({ name: 'Sam' });
        expect(shown.profilePending).not.toBeNull();
        expect(overlays.find((overlay) => overlay.mode === 'insert')?.key.startsWith('pending-memory-')).toBe(true);
        expect(MEMORY_WRITE_VIEWS.map((kind) => kind.kind)).toContain(MEMORY_ADD_KIND);
    });
});
