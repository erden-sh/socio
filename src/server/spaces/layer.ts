/**
 * The Spaces layers: they implement `contract.ts`, yielding what they need from
 * other features' contracts: the process's runtime identity (`RuntimeIdentity`),
 * the workspace's slices (`People`, `Socios`, `Conversations`, `Spaces`),
 * the approvals (`Approvals`) and the workspace's settings
 * (`WorkspaceSettings`). Only the composition root (`composition/spaces.ts`)
 * and tests import this file.
 *
 * Spaces reads no `PlatformConfig` field (its memory retention comes
 * through Settings' `Limits`), so there is no `SpacesConfig`.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import { Approvals } from '../approvals/contract.js';
import { RuntimeIdentity, type RuntimeOwnershipShape } from '../runtime/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Conversations, People, Socios, Spaces } from '../workspace/contract.js';

import type { SpaceAccess } from './access.js';
import {
    Access,
    Creation,
    SPACE_DELETE_CONTRACT,
    SPACE_DELETE_CONTRACT_NAME,
    SPACE_PRIVACY_CONTRACT,
    SPACE_PRIVACY_CONTRACT_NAME,
} from './contract.js';
import { SpaceCreation, type SpaceCreationWorkspace } from './create.js';

/**
 * Private and deleted Spaces (CB-181, CB-277), each only while every live
 * runtime enforces it: this runtime records both contracts on `ownership`,
 * and the access asks it whether any live runtime is behind.
 */
export function useSpaceContracts(
    access: Pick<SpaceAccess, 'usePrivacyContract' | 'useDeleteContract'>,
    ownership: Pick<RuntimeOwnershipShape, 'recordContract' | 'contractBehind'>,
) {
    // Private Spaces (CB-181): this build keeps everything in one from
    // anyone outside it; a Space is made private only while every live
    // runtime does (a start-first deploy's previous release does not).
    ownership.recordContract(SPACE_PRIVACY_CONTRACT_NAME, SPACE_PRIVACY_CONTRACT);
    access.usePrivacyContract(() => !ownership.contractBehind(SPACE_PRIVACY_CONTRACT_NAME, SPACE_PRIVACY_CONTRACT));
    // Deleted Spaces (CB-277): this build answers one as missing on every
    // read path; a Space is deleted only while every live runtime does.
    ownership.recordContract(SPACE_DELETE_CONTRACT_NAME, SPACE_DELETE_CONTRACT);
    access.useDeleteContract(() => !ownership.contractBehind(SPACE_DELETE_CONTRACT_NAME, SPACE_DELETE_CONTRACT));
}

/**
 * Where the Spaces' access lives: the workspace holds it (`SpaceAccess`,
 * built on its connection by the factory from `composition/workspace-parts.ts`).
 */
export interface SpaceAccessSource {
    readonly db: DatabaseSync;
    readonly spaceAccess: SpaceAccess;
}

/**
 * `Access`: the workspace's `SpaceAccess`, once this runtime's ownership
 * on its connection records the two contracts and the access asks it.
 * `source` is read when the layer is built.
 */
export const AccessLive = <R>(source: Effect.Effect<SpaceAccessSource, never, R>) =>
    Layer.effect(
        Access,
        Effect.gen(function* () {
            const { db, spaceAccess } = yield* source;
            const identity = yield* RuntimeIdentity;
            useSpaceContracts(spaceAccess, identity.attach(db));
            return Access.of(spaceAccess);
        }),
    );

/** What making a Space reads of the workspace, from the tags' slices. */
export const spaceCreationWorkspace = Effect.gen(function* () {
    const people = yield* People;
    const socios = yield* Socios;
    const conversations = yield* Conversations;
    const spaces = yield* Spaces;
    const spaceAccess = yield* Access;
    return {
        users: () => people.users(),
        isDeactivated: (userId) => people.isDeactivated(userId),
        dot: (dotId) => socios.dot(dotId),
        chatReaders: (threadId) => conversations.chatReaders(threadId),
        createSpaceFor: (by, input) => spaces.createSpaceFor(by, input),
        spaceAccess,
    } satisfies SpaceCreationWorkspace;
});

/**
 * A socio's `create_space` (CB-271), on its person's approval, under the
 * workspace's "create Spaces" permission (read on every create). Building
 * it registers its approval capability. The composition root also holds
 * it as `LegacySpaceCreation` (the class), so it is an Effect as well
 * as a layer.
 */
export const spaceCreation = Effect.gen(function* () {
    const workspace = yield* spaceCreationWorkspace;
    const approvals = yield* Approvals;
    const settings = yield* WorkspaceSettings;
    return new SpaceCreation(workspace, approvals, () => settings.settings());
});

export const CreationLive = Layer.effect(Creation, spaceCreation);
