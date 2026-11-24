// The app's services for a module hook a test calls with a context of its
// own, without a platform: the tags the hooks read in place of the context's
// old `store`, `workspace` and `config`, over the store and the workspace
// the test made, as the root's layers offer them. Tags a test needs beyond
// those come in `extra`.
import { Context, Effect } from 'effect';

import { AppsTelegram } from '../../src/server/apps/contract.js';
import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import { ComputerRecords } from '../../src/server/computers/contract.js';
import { DataViewPages } from '../../src/server/dataspace/contract.js';
import { Counters } from '../../src/server/live/contract.js';
import {
    Episodes,
    MemoryItems,
    MemorySpaces,
    MemoryTelegram,
    SpaceMemories,
} from '../../src/server/memory/contract.js';
import type { ModuleServicesAccess } from '../../src/server/modules/contract.js';
import { RoomsWorkspace } from '../../src/server/rooms/tags.js';
import { Tasks } from '../../src/server/schedules/contract.js';
import { ScheduleStore } from '../../src/server/schedules/tags.js';
import { SecretSettings, WorkspaceSettings } from '../../src/server/settings/contract.js';
import { Souls } from '../../src/server/souls/contract.js';
import { Access } from '../../src/server/spaces/contract.js';
import { Links } from '../../src/server/telegram/contract.js';
import { Audit, Conversations, People, Socios, Spaces } from '../../src/server/workspace/contract.js';

import type { Store } from './stores.js';

/** A tag and the service a test offers for it. */
// oxlint-disable-next-line typescript/no-explicit-any -- any tag, with its own service
export type TestService = readonly [Context.Key<any, any>, unknown];

/**
 * `ModuleServicesAccess` over the store's and the workspace's own objects
 * (and `extra`): `get` throws for a tag none of them offers, and `run`
 * runs an Effect with them.
 */
export function testModuleServices(
    parts: { store?: Store; workspace?: WorkspaceStore },
    extra: readonly TestService[] = [],
): ModuleServicesAccess {
    const { store, workspace } = parts;
    const entries: TestService[] = [];
    if (store) {
        entries.push(
            [WorkspaceSettings, store.slices.settings],
            [SecretSettings, store.slices.secrets],
            [MemoryItems, store.memoryItems],
            [Episodes, store.episodes],
            [SpaceMemories, store.spaceMemories],
            // Scheduling's view of the store and its task service.
            [ScheduleStore, store],
            [Tasks, store.scheduled],
        );
    }
    if (workspace) {
        entries.push(
            [People, workspace.slices.people],
            [Spaces, workspace.slices.spaces],
            [Socios, workspace.slices.socios],
            [Audit, workspace.slices.audit],
            [Conversations, workspace.slices.conversations],
            [Access, workspace.spaceAccess],
            [Links, workspace.telegram],
            [ComputerRecords, workspace.computers],
            // Memory's ports over telegram's `Links` and the Spaces' `Access`.
            [MemoryTelegram, workspace.telegram],
            [MemorySpaces, workspace.spaceAccess],
            // What other modules' hooks read of the workspace in place of
            // the platform's.
            [Souls, workspace.souls],
            [Counters, workspace.counters],
            [RoomsWorkspace, workspace],
            [AppsTelegram, workspace.telegram],
            [DataViewPages, workspace.pages],
        );
    }
    entries.push(...extra);
    let context: Context.Context<never> = Context.empty();
    for (const [tag, service] of entries) {
        context = Context.add(context, tag, service as never) as Context.Context<never>;
    }
    return {
        get: (tag) => {
            const service = Context.getOrUndefined(context, tag);
            if (service === undefined) {
                throw new Error(`The test offers no ${tag.key}.`);
            }
            return service;
        },
        run: (effect) => Effect.runPromise(Effect.provideContext(effect, context as never)),
    };
}
