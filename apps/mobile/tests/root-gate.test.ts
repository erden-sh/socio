import { describe, expect, it, vi } from 'vitest';

import {
    createMemoryRootState,
    createRegistryRootState,
    NO_WORKSPACE,
    readRootState,
    ROOT_GATES,
    type RootGate,
    rootGate,
    type RootState,
    type RootStateRegistry,
} from '../src/navigation/root-gate';
import {
    gateRoot,
    ROOT_ROUTE_NAMES,
    ROUTE_NAMES,
    ROUTES,
    type RouteSpec,
    routeShows,
    staticScreens,
    wayOut,
} from '../src/navigation/routes';

import { navigationCore } from './helpers/navigation-core';

// The root gate: which state the
// root state gives, which routes each state shows, and where React
// Navigation's stack router lands when the gate changes them.

// Each screen's `if` is a hook. Called outside a render, it reads its source's
// snapshot, as React would.
vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const LOCKED = { active: { id: 'a', locked: true } };
const OPEN = { active: { id: 'a', locked: false } };
const STATES: Record<RootGate, RootState> = { 'add-workspace': NO_WORKSPACE, locked: LOCKED, shell: OPEN };

// The root stack's screens as root-stack.tsx builds them, gated by a source the tests move.
const source = createMemoryRootState();
const screens = staticScreens(
    Object.fromEntries(ROOT_ROUTE_NAMES.map((name) => [name, () => null])) as never,
    'development',
    source,
);

/** The screens the static API renders, in its order: those whose `if` holds now. */
const rendered = () =>
    Object.entries(screens)
        .filter(([, screen]) => screen.if())
        .map(([name]) => name);

describe('the root gate', () => {
    it('opens Add workspace with no workspace or while adding one, the lock screen for a locked copy, else the shell', () => {
        expect(rootGate(NO_WORKSPACE)).toBe('add-workspace');
        expect(rootGate({ ...OPEN, adding: true })).toBe('add-workspace');
        expect(rootGate({ ...LOCKED, adding: true })).toBe('add-workspace');
        expect(rootGate(LOCKED)).toBe('locked');
        expect(rootGate(OPEN)).toBe('shell');
    });

    it('opens each state on its placeholder', () => {
        expect(gateRoot('add-workspace')).toBe('AddWorkspace');
        expect(gateRoot('locked')).toBe('Lock');
        expect(gateRoot('shell')).toBe('Tabs');
    });

    it('shows no route a link opens while the copy is locked, so no link opens past the lock screen', () => {
        const linkable = ROUTE_NAMES.filter((name) => (ROUTES[name] as RouteSpec).linking !== undefined);
        expect(linkable.length).toBeGreaterThan(0);
        expect(linkable.filter((name) => routeShows(name, 'locked'))).toEqual([]);
    });

    it('gives each state a root no other state shows, so a gate change always leaves it', () => {
        for (const gate of ROOT_GATES) {
            const others = ROOT_GATES.filter((other) => other !== gate);
            expect(
                others.filter((other) => routeShows(gateRoot(gate), other)),
                gate,
            ).toEqual([]);
        }
    });

    it('names only known gate states in the route table, and every route is shown by one', () => {
        for (const name of ROUTE_NAMES) {
            const { gates } = ROUTES[name];
            expect(gates.length, name).toBeGreaterThan(0);
            expect(
                gates.every((gate) => ROOT_GATES.includes(gate)),
                name,
            ).toBe(true);
        }
    });
});

describe("each screen's `if`", () => {
    it('follows the root state as it moves between no workspace, locked and open', () => {
        for (const state of [NO_WORKSPACE, LOCKED, OPEN, LOCKED, NO_WORKSPACE, OPEN]) {
            source.set(state);
            const gate = rootGate(state);
            // The pages that live in the tabs' own stacks show only with the tabs, so only in the shell.
            expect(rendered(), gate).toEqual(
                ROOT_ROUTE_NAMES.filter((name) => (ROUTES[name].gates as readonly RootGate[]).includes(gate)),
            );
        }
    });
});

describe("the stack router, given each state's screens", () => {
    const router = navigationCore.StackRouter({});
    const config = { routeParamList: {}, routeGetIdList: {} };
    const routeNames = (gate: RootGate) => {
        source.set(STATES[gate]);
        return rendered();
    };
    const focused = (state: { index: number; routes: readonly { name: string }[] }) => state.routes[state.index]?.name;

    it.each(ROOT_GATES)("opens on the state's root while %s", (gate) => {
        expect(focused(router.getInitialState({ ...config, routeNames: routeNames(gate) }))).toBe(gateRoot(gate));
    });

    const changes = ROOT_GATES.flatMap((from) => ROOT_GATES.filter((to) => to !== from).map((to) => [from, to]));

    it.each(changes)("lands on the new state's root when %s turns %s", (from, to) => {
        const before = router.getInitialState({ ...config, routeNames: routeNames(from) });
        const after = router.getStateForRouteNamesChange(before, {
            ...config,
            routeNames: routeNames(to),
            routeKeyChanges: [],
        });
        expect(focused(after)).toBe(gateRoot(to));
    });
});

describe('a root state in memory', () => {
    it('holds no workspace until it is set', () => {
        expect(createMemoryRootState().get()).toBe(NO_WORKSPACE);
    });

    it('tells its listeners about a change, once, until they unsubscribe', () => {
        const source = createMemoryRootState();
        const listener = vi.fn();
        const unsubscribe = source.subscribe(listener);

        source.set(LOCKED);
        source.set(LOCKED);
        expect(listener).toHaveBeenCalledOnce();
        expect(rootGate(source.get())).toBe('locked');

        unsubscribe();
        source.set(OPEN);
        expect(listener).toHaveBeenCalledOnce();
        expect(rootGate(source.get())).toBe('shell');
    });
});

describe('the root state from the registry', () => {
    type Row = { state: string; endedAt: number | null; leaseLockedAt: number | null };
    /** A registry with one row per id and an active one, which the tests move. */
    const registry = (rows: Record<string, Row>, active: { id: string | null }): RootStateRegistry => ({
        active: async () => active.id,
        get: async (id) => (rows[id] === undefined ? null : { ...rows[id], id }) as never,
    });
    const ready: Row = { state: 'ready', endedAt: null, leaseLockedAt: null };

    it('opens Add workspace with none active, the shell for a ready one, the lock for an ended or lease-locked one', async () => {
        const rows = {
            a: ready,
            ended: { ...ready, endedAt: 1 },
            lease: { ...ready, leaseLockedAt: 2 },
            wiping: { ...ready, state: 'wiping' },
        };
        const gate = async (id: string | null) => rootGate(await readRootState(registry(rows, { id })));
        expect(await gate(null)).toBe('add-workspace');
        expect(await gate('a')).toBe('shell');
        expect(await gate('ended')).toBe('locked');
        expect(await gate('lease')).toBe('locked');
        // A row no longer there, or marked for a wipe, is no workspace.
        expect(await gate('gone')).toBe('add-workspace');
        expect(await gate('wiping')).toBe('add-workspace');
    });

    it('knows its state once loaded, and tells its listeners when a refresh finds another gate', async () => {
        const active = { id: null as string | null };
        const rows: Record<string, Row> = { a: ready };
        const source = createRegistryRootState();
        await source.load(registry(rows, active));
        expect(source.get()).toBe(NO_WORKSPACE);

        const listener = vi.fn();
        source.subscribe(listener);
        active.id = 'a';
        await source.refresh();
        expect(rootGate(source.get())).toBe('shell');
        await source.refresh();
        expect(listener).toHaveBeenCalledOnce();

        rows.a = { ...ready, endedAt: 3 };
        await source.refresh();
        expect(rootGate(source.get())).toBe('locked');
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('tells its listeners about a switch, which keeps the gate but changes the workspace', async () => {
        const active = { id: 'a' as string | null };
        const source = createRegistryRootState();
        await source.load(registry({ a: ready, b: ready }, active));
        expect(source.get().active).toEqual({ id: 'a', locked: false });
        const listener = vi.fn();
        source.subscribe(listener);
        active.id = 'b';
        await source.refresh();
        expect(listener).toHaveBeenCalledOnce();
        expect(rootGate(source.get())).toBe('shell');
        expect(source.get().active).toEqual({ id: 'b', locked: false });
    });

    it('shows Add workspace while adding another, until Cancel or the sign-in that ends it', async () => {
        const active = { id: 'a' as string | null };
        const source = createRegistryRootState();
        await source.load(registry({ a: ready, b: ready }, active));
        const listener = vi.fn();
        source.subscribe(listener);

        // "Add a workspace", then Cancel: back on the same workspace.
        source.setAdding(true);
        expect(rootGate(source.get())).toBe('add-workspace');
        expect(source.get().active?.id).toBe('a');
        await source.refresh();
        expect(rootGate(source.get())).toBe('add-workspace');
        source.setAdding(false);
        expect(rootGate(source.get())).toBe('shell');
        expect(listener).toHaveBeenCalledTimes(2);

        // Adding again; the sign-in commits b and ends adding in one change: no shell of a between.
        source.setAdding(true);
        active.id = 'b';
        await source.refresh({ adding: false });
        expect(listener).toHaveBeenCalledTimes(4);
        expect(source.get()).toEqual({ active: { id: 'b', locked: false } });
        expect(rootGate(source.get())).toBe('shell');
    });

    it('opens Add workspace, not adding, once no workspace is left', async () => {
        const active = { id: 'a' as string | null };
        const source = createRegistryRootState();
        await source.load(registry({ a: ready }, active));
        source.setAdding(true);
        active.id = null;
        await source.refresh();
        expect(source.get()).toBe(NO_WORKSPACE);
        // A sign-in later shows the shell: adding didn't outlive the workspace it would come back to.
        active.id = 'a';
        await source.refresh();
        expect(rootGate(source.get())).toBe('shell');
    });
});

describe("a failed screen's way out", () => {
    it('goes back when there is a page under it', () => {
        expect(wayOut('Chats', true, 'shell')).toBe('back');
    });

    it("replaces a screen with nothing under it by its state's root", () => {
        expect(wayOut('SomeLaterScreen', false, 'shell')).toBe('Tabs');
        // A tab that fails with no tab to go back to: the tabs again, from their first.
        expect(wayOut('Inbox', false, 'shell')).toBe('Tabs');
        expect(wayOut('SomeLaterScreen', false, 'add-workspace')).toBe('AddWorkspace');
    });

    it('offers only Try again on a root', () => {
        for (const gate of ROOT_GATES) {
            expect(wayOut(gateRoot(gate), false, gate), gate).toBeNull();
        }
    });
});
