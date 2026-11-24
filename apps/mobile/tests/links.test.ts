import { describe, expect, it, vi } from 'vitest';

import { createExternalLinks, type LinkAction, type LinkNavigator, type LinkTarget } from '../src/navigation/links';

// The queue for taps from outside the app:
// a link waits until the root stack is ready and has the screen it opens, so
// none opens past the lock screen or Add workspace, then opens once.

/** A container standing in for React Navigation's, with the root stack's current routes. */
function fakeContainer(routeNames: string[], ready = true) {
    const dispatched: LinkAction[] = [];
    const container = {
        ready,
        routeNames,
        isReady: () => container.ready,
        getRootState: () => ({ key: 'root-1', routeNames: container.routeNames }),
        dispatch: (action: LinkAction) => {
            dispatched.push(action);
        },
    };
    return { container: container satisfies LinkNavigator, dispatched };
}

const navigate = (name: string, params?: object): LinkTarget => ({
    routes: [name],
    action: { type: 'NAVIGATE', payload: { name, params } },
});

// Chats are workspace content, shown only by the shell; an "Add your phone" link opens Add workspace.
const resolve = (path: string): LinkTarget | undefined => {
    if (path.startsWith('/chats/')) {
        return navigate('Chat', { id: path.slice('/chats/'.length) });
    }
    return path === '/add' ? navigate('AddWorkspace') : undefined;
};

const SHELL = ['Home', 'Chat'];

const queue = () => {
    const report = vi.fn();
    return { links: createExternalLinks({ resolve, report }), report };
};

describe('external links', () => {
    it('wait for the container, then open once, at the root stack', () => {
        const { links } = queue();
        links.open('/chats/a');
        expect(links.pending()).toBe('/chats/a');

        const { container, dispatched } = fakeContainer(SHELL, false);
        links.attach(container);
        links.flush();
        expect(dispatched).toEqual([]);

        container.ready = true;
        links.flush();
        links.flush();
        expect(dispatched).toEqual([
            { target: 'root-1', type: 'NAVIGATE', payload: { name: 'Chat', params: { id: 'a' } } },
        ]);
        expect(links.pending()).toBeNull();
    });

    it.each([
        ['the lock screen', ['Lock']],
        ['Add workspace', ['AddWorkspace']],
    ])("wait while %s shows, and open when the gate shows the link's screen", (_, gateRoutes) => {
        const { links } = queue();
        const { container, dispatched } = fakeContainer(gateRoutes);
        links.attach(container);

        links.open('/chats/a');
        links.flush();
        expect(dispatched).toEqual([]);

        // The gate opens: the root stack's routes change, and onStateChange flushes.
        container.routeNames = SHELL;
        links.flush();
        expect(dispatched).toHaveLength(1);
    });

    it('open at once when the root stack already has the screen', () => {
        const { links } = queue();
        const shell = fakeContainer(SHELL);
        links.attach(shell.container);
        links.open('/chats/now');
        expect(shell.dispatched.map((action) => action.payload)).toEqual([{ name: 'Chat', params: { id: 'now' } }]);

        const noWorkspace = fakeContainer(['AddWorkspace']);
        links.attach(noWorkspace.container);
        links.open('/add');
        expect(noWorkspace.dispatched.map((action) => action.payload)).toEqual([{ name: 'AddWorkspace' }]);
    });

    it('open a route with no path by name, waiting for the gate to show it (the sheet callback)', () => {
        const { links, report } = queue();
        const { container, dispatched } = fakeContainer(SHELL);
        links.attach(container);
        links.openRoute('SheetSignIn');
        expect(dispatched).toEqual([]);
        expect(links.pending()).toBe('route:SheetSignIn');

        // Adding a workspace starts: the gate shows Add workspace's routes.
        container.routeNames = ['AddWorkspace', 'SheetSignIn'];
        links.flush();
        expect(dispatched).toEqual([{ target: 'root-1', type: 'NAVIGATE', payload: { name: 'SheetSignIn' } }]);
        expect(links.pending()).toBeNull();
        expect(report).not.toHaveBeenCalled();
    });

    it('open a route by going back to it when asked (`popTo`: a gate root, never a second copy)', () => {
        const { links } = queue();
        const { container, dispatched } = fakeContainer(['AddWorkspace', 'ConfirmWorkspace']);
        links.attach(container);
        links.openRoute('AddWorkspace', 'popTo');
        expect(dispatched).toEqual([{ target: 'root-1', type: 'POP_TO', payload: { name: 'AddWorkspace' } }]);
    });

    it('keep only the latest tap while waiting', () => {
        const { links } = queue();
        const { container, dispatched } = fakeContainer(['Lock']);
        links.attach(container);
        links.open('/chats/first');
        links.open('/chats/second');

        container.routeNames = SHELL;
        links.flush();
        expect(dispatched.map((action) => action.payload)).toEqual([{ name: 'Chat', params: { id: 'second' } }]);
    });

    it('report a path no screen opens, keeping the link that waits', () => {
        const { links, report } = queue();
        const { container, dispatched } = fakeContainer(['Lock']);
        links.attach(container);
        links.open('/chats/a');

        links.open('/nowhere');
        expect(report).toHaveBeenCalledWith('[links] no screen opens /nowhere');
        expect(links.pending()).toBe('/chats/a');

        container.routeNames = SHELL;
        links.flush();
        expect(dispatched).toHaveLength(1);
    });

    it('report a navigation that throws, and carry on', () => {
        const { links, report } = queue();
        const { container } = fakeContainer(SHELL);
        const failure = new Error('unknown route');
        container.dispatch = () => {
            throw failure;
        };
        links.attach(container);
        links.open('/chats/a');
        expect(report).toHaveBeenLastCalledWith('[links] opening /chats/a failed', failure);
        expect(links.pending()).toBeNull();
    });

    it("keep the newer container when an older root unmounts after it attached (Android's activity replacement)", () => {
        const { links } = queue();
        const older = fakeContainer(SHELL);
        const newer = fakeContainer(SHELL);
        const detachOlder = links.attach(older.container);
        const detachNewer = links.attach(newer.container);

        detachOlder();
        links.open('/chats/a');
        expect(newer.dispatched).toHaveLength(1);
        expect(older.dispatched).toEqual([]);

        detachNewer();
        links.open('/chats/b');
        expect(links.pending()).toBe('/chats/b');
    });

    it('take app paths only', () => {
        const { links } = queue();
        expect(() => links.open('chats/a')).toThrow("An app path starts with '/' (chats/a).");
        expect(links.pending()).toBeNull();
    });
});
