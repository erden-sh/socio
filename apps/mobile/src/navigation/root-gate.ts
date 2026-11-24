import { useSyncExternalStore } from 'react';

import type { Registry } from '../data/registry';

// The root gate: with no workspace
// on the phone the app opens Add workspace, and so does "Add a workspace" in
// the account sheet until the person signs in or cancels; with the
// active workspace's copy locked (Ended, or its lease ran out) the lock screen
// comes first; otherwise the shell, on the active workspace's scope
// (src/platform/active-scope.ts). The route table (routes.ts) says which gate state shows each
// route, so a locked phone has no route to any workspace content: a link or a
// back gesture can't reach past the lock screen.

/** What the gate reads: the active workspace's state, from the registry. */
export interface RootState {
    /** The active workspace (its directory id), or null when the phone holds none. */
    readonly active: { readonly id: string; readonly locked: boolean } | null;
    /** The person is adding another workspace (the account sheet's "Add a workspace"). */
    readonly adding?: boolean;
}

export type RootGate = 'add-workspace' | 'locked' | 'shell';

export const ROOT_GATES: readonly RootGate[] = ['add-workspace', 'locked', 'shell'];

export function rootGate(state: RootState): RootGate {
    if (state.active === null || state.adding === true) {
        return 'add-workspace';
    }
    return state.active.locked ? 'locked' : 'shell';
}

/**
 * Where the root state comes from: a snapshot and change events, in
 * useSyncExternalStore's shape. It must know its state before the first frame,
 * so `get` never waits.
 */
export interface RootStateSource {
    get(): RootState;
    subscribe(listener: () => void): () => void;
}

export const NO_WORKSPACE: RootState = { active: null };

/** A source held in memory, which anything can set. */
export function createMemoryRootState(initial: RootState = NO_WORKSPACE): RootStateSource & {
    set(next: RootState): void;
} {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next) {
            if (next !== state) {
                state = next;
                for (const listener of [...listeners]) {
                    listener();
                }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** The slice of the registry (src/data/registry.ts) the gate reads. */
export type RootStateRegistry = Pick<Registry, 'active' | 'get'>;

/**
 * The gate's state as the registry holds it: no workspace when none is active
 * (or the active row isn't ready, which a wipe's mark already rules out), and
 * locked when the active workspace's session ended (`endedAt`) or its lease
 * locked it (`leaseLockedAt`).
 */
export async function readRootState(registry: RootStateRegistry): Promise<RootState> {
    const id = await registry.active();
    const row = id === null ? null : await registry.get(id);
    if (row === null || row.state !== 'ready') {
        return NO_WORKSPACE;
    }
    return { active: { id: row.id, locked: row.endedAt !== null || row.leaseLockedAt !== null } };
}

/** The root state read from the registry: launch loads it before the first frame, and a change to the registry refreshes it. */
export interface RegistryRootState extends RootStateSource {
    /** Reads the state from `registry`, which later refreshes read again. */
    load(registry: RootStateRegistry): Promise<void>;
    /**
     * Reads the state again, after a sign-in, a wipe, a switch or a lock changed
     * the registry. `adding` starts or ends adding a workspace in the same
     * change, so a sign-in shows the new workspace without the old one between.
     */
    refresh(options?: { readonly adding?: boolean }): Promise<void>;
    /** Starts or ends adding a workspace, at once ("Add a workspace", Cancel). Ending it with no workspace changes nothing. */
    setAdding(adding: boolean): void;
}

/** Two states that open the same gate on the same copy. */
const sameState = (a: RootState, b: RootState) =>
    (a.adding === true) === (b.adding === true) &&
    (a.active === null || b.active === null
        ? a.active === b.active
        : a.active.id === b.active.id && a.active.locked === b.active.locked);

export function createRegistryRootState(): RegistryRootState {
    const memory = createMemoryRootState();
    let source: RootStateRegistry | null = null;
    let adding = false;
    const show = (read: RootState) => {
        // Adding needs a workspace to come back to: with none left, Add workspace is the gate anyway, and adding ends.
        if (read.active === null) {
            adding = false;
        }
        const next = adding ? { ...read, adding: true } : read;
        if (!sameState(next, memory.get())) {
            memory.set(next);
        }
    };
    const refresh = async (options: { readonly adding?: boolean } = {}) => {
        if (source === null) {
            return;
        }
        const read = await readRootState(source);
        adding = options.adding ?? adding;
        show(read);
    };
    return {
        get: memory.get,
        subscribe: memory.subscribe,
        load: async (registry) => {
            source = registry;
            await refresh();
        },
        refresh,
        setAdding(on) {
            adding = on;
            show({ active: memory.get().active });
        },
    };
}

/**
 * The app's root state, from the registry. Launch (src/platform/device-store.ts)
 * loads it once the store is open, before the first frame, so `get` already
 * knows it; until then it holds no workspace.
 */
export const rootState: RegistryRootState = createRegistryRootState();

/** The gate state now, re-rendering when it changes. */
export function useRootGate(source: RootStateSource = rootState): RootGate {
    return rootGate(useSyncExternalStore(source.subscribe, source.get));
}

/** The root state now, re-rendering when it changes. */
export function useRootState(source: RootStateSource = rootState): RootState {
    return useSyncExternalStore(source.subscribe, source.get);
}
