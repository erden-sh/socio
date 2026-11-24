import { afterEach, describe, expect, it } from 'vitest';

import type { IssueComponentOptions } from '@socio/shared/issues/issue-components';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { componentPicker, LOADING_COMPONENTS } from '../../src/shell/issue-components';
import {
    createIssueComponentOptions,
    ISSUE_COMPONENT_OPTIONS,
    type IssueComponentOptionList,
    OPTIONS_KEY,
} from '../../src/sync/issue-component-options';

import { syncSetup } from './helpers';

// The component options (CB-442), a bounded kind of `GET /api/issues/components`
// against a real cache.db: read only while the picker uses it; kept on disk, so
// offline the picker shows the last list with its age and "Needs a
// connection"; a refusal keeps it, never drops it; a body that isn't one
// applies nothing.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Array<{ s: Setup; list: IssueComponentOptionList }> = [];
afterEach(async () => {
    for (const { s, list } of open.splice(0)) {
        await list.close().catch(() => {});
        await s.close().catch(() => {});
    }
});

const OPTIONS: IssueComponentOptions = {
    options: [
        { ref: 'plugins:*', label: 'All plugins', kind: 'plugins' },
        { ref: 'apps:*', label: 'All apps', kind: 'apps' },
        { ref: 'plugin:forms', label: 'Forms', kind: 'plugin', state: 'live' },
        { ref: 'app:crm', label: 'CRM', kind: 'app', ownerName: 'Ada' },
    ],
};

async function setup(directory?: string) {
    const s = await syncSetup(directory === undefined ? {} : { directory });
    const server = { mode: 'ok' as 'ok' | 'offline' | 'refuse', requests: [] as string[], body: OPTIONS as unknown };
    const fetch: AuthedFetch = async (path) => {
        server.requests.push(path);
        if (server.mode === 'offline') {
            throw new NetworkError(path);
        }
        return server.mode === 'refuse'
            ? new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 })
            : new Response(JSON.stringify(server.body), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
              });
    };
    const list = createIssueComponentOptions({ db: s.db, fetch, now: s.clock.device });
    open.push({ s, list });
    return { s, list, server };
}

const settle = async (list: IssueComponentOptionList) => {
    const item = list.item(OPTIONS_KEY);
    await item.loaded;
    await item.refresh();
    return item;
};

describe('the component options (CB-442)', () => {
    it('reads nothing until the picker uses it, then keeps the list on disk', async () => {
        const { list, server } = await setup();
        const item = list.item(OPTIONS_KEY);
        expect(server.requests).toEqual([]);
        expect(componentPicker({ list: item.state, value: [], query: '' }).line).toBe(LOADING_COMPONENTS);
        const release = item.use();
        await item.refresh();
        expect(server.requests[0]).toBe('/api/issues/components');
        expect(item.state.value).toEqual(OPTIONS);
        release();
        await list.flush();
        expect(await list.stored(OPTIONS_KEY)).toBe(true);
    });

    it('offline, the picker shows the last list with its age and "Needs a connection"', async () => {
        const first = await setup();
        await settle(first.list);
        await first.list.flush();
        await first.list.close();
        await first.s.close({ remove: false });
        open.splice(0);

        const again = await setup(first.s.directory);
        again.server.mode = 'offline';
        const item = await settle(again.list);
        const view = componentPicker({ list: item.state, value: ['app:crm'], query: '', timeZone: 'UTC' });
        expect(view.groups.map((group) => [group.title, group.choices.map((choice) => choice.label)])).toEqual([
            ['All', ['All plugins', 'All apps']],
            ['Plugins', ['Forms']],
            ['Apps', ['CRM']],
        ]);
        expect(view.groups[2]!.choices[0]).toMatchObject({ selected: true, detail: 'Ada' });
        expect(view.line).toBe('Needs a connection');
        expect(view.age).toMatch(/^Saved /);
    });

    it('a refusal (an older server has no such route) keeps the last list', async () => {
        const { list, server } = await setup();
        await settle(list);
        server.mode = 'refuse';
        const item = await settle(list);
        expect(item.state).toMatchObject({ value: OPTIONS, failed: true, gone: false });
    });

    it('refuses a body that isn’t the options', () => {
        const parse = (body: unknown) => ISSUE_COMPONENT_OPTIONS.parse('/api/issues/components', body);
        expect(() => parse({})).toThrow();
        expect(() => parse({ options: [{ ref: 'forms', label: 'Forms', kind: 'plugin' }] })).toThrow();
        expect(() => parse({ options: [{ ref: 'plugin:forms', label: 'Forms', kind: 'widget' }] })).toThrow();
        expect(parse(OPTIONS)).toEqual(OPTIONS);
    });
});
