/**
 * The stores the workspace holds beside its slices, as the composition root
 * builds them: `workspace/workspace.ts`'s `WorkspaceStore` builds its slices,
 * and `workspaceStoreParts` hands it the stores beside them that other folders
 * own, built as the store's constructor built them before: the change counters,
 * the room and Space access rules, the Souls, the computers, the Telegram
 * links, the task threads, the published skills, the evidence ledger, the pages
 * and the learning analysis. `AppWorkspace` is the store over them, with their
 * classes as its type parameter; the boot step opens it
 * (`new WorkspaceStore(connection, workspaceStoreParts)`).
 */
import type { ComputerStore } from '../computers/computer-store.js';
import { LearningAnalysis } from '../learning/analysis.js';
import { EvidenceLedger } from '../learning/evidence.js';
import { SkillStore } from '../learning/skills.js';
import { ChangeCounters } from '../live/change-counters.js';
import { Pages } from '../pages/pages.js';
import { RoomAccess } from '../rooms/access.js';
import { sqliteRoomAccessReader, sqliteRoomRepositories } from '../rooms/infra/sqlite/repositories.js';
import type { TaskThreadRepository } from '../schedules/contract.js';
import { sqliteTaskThreads } from '../schedules/infra/sqlite/index.js';
import { SoulStore } from '../souls/souls.js';
import { SpaceAccess } from '../spaces/access.js';
import { SpaceAccessError } from '../spaces/contract.js';
import { sqliteSpaceAccess } from '../spaces/infra/sqlite/repositories.js';
import type { TelegramLinks } from '../telegram/telegram-links.js';
import type { WorkspaceStore, WorkspaceStoreParts } from '../workspace/workspace.js';

import { computerStoreOn, telegramLinksOn } from './integration-stores.js';

/** Opens the learning analysis job over one workspace's evidence. */
type OpenAnalysis = (
    runner: ConstructorParameters<typeof LearningAnalysis>[2],
    config: ConstructorParameters<typeof LearningAnalysis>[3],
    fetchImpl?: typeof fetch,
    reactions?: ConstructorParameters<typeof LearningAnalysis>[5],
) => LearningAnalysis;

/** The classes of the stores beside the workspace's slices (`WorkspaceStoreTypes`). */
export interface AppWorkspaceTypes {
    pages: Pages;
    souls: SoulStore;
    computers: ComputerStore;
    telegram: TelegramLinks;
    evidence: EvidenceLedger;
    skills: SkillStore;
    counters: ChangeCounters;
    roomAccess: RoomAccess;
    spaceAccess: SpaceAccess;
    taskThreads: TaskThreadRepository;
    openAnalysis: OpenAnalysis;
}

/** The workspace as the server opens it: over `workspaceStoreParts`. */
export type AppWorkspace = WorkspaceStore<AppWorkspaceTypes>;

/** The stores beside the workspace's slices, on its connection. */
export const workspaceStoreParts: WorkspaceStoreParts<AppWorkspaceTypes> = {
    counters: (db) => new ChangeCounters(db),
    roomAccess: (data, { topicReader, enabled }) => {
        const roomEvents = sqliteRoomRepositories(data).events;
        return new RoomAccess({
            reader: sqliteRoomAccessReader(data),
            topicReader,
            enabled,
            // A refusal is a record nothing reads back at once (CB-110).
            audit: (event) =>
                void roomEvents.append(event).catch(() => console.error('Rooms: a refusal could not be audited.')),
        });
    },
    spaceAccess: (data, deps) => new SpaceAccess({ repository: sqliteSpaceAccess(data), ...deps }),
    spaceAccessError: (message, status) => new SpaceAccessError(message, status),
    souls: (db, audit) => new SoulStore(db, audit),
    computers: (db) => computerStoreOn(db),
    telegram: (db) => telegramLinksOn(db),
    taskThreads: (data) => sqliteTaskThreads(data),
    skills: (db) => new SkillStore(db),
    evidence: (db, containerOf) => new EvidenceLedger(db, containerOf),
    pages: (db, spaceExists, isPerson) => new Pages(db, spaceExists, isPerson),
    openAnalysis: (db, evidence) => (runner, config, fetchImpl, reactions) =>
        new LearningAnalysis(db, evidence, runner, config, fetchImpl, reactions),
};
