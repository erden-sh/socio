/**
 * Chat skills' construction: `skills/layer.ts` builds every skills tag on the
 * workspace's connection (the same one-per-database repositories the socios
 * use), the registry over them, `/compact` and `/unfurl`'s tools. Skills read
 * no `PlatformConfig` field, so there is no `SkillsConfig` to build.
 */
import { Effect, Layer } from 'effect';

import { makeSkills } from '../skills/layer.js';

import { LegacyWorkspace } from './base.js';

/**
 * Chat skills' step of the graph: `WorkspaceSkills` and `SkillSessions`
 * (the connection's own repositories), `SkillRegistry` over them,
 * `Compact` and `UnfurlTools`. It comes after the context's and the
 * pages' bridges, whose `ContextFitting` and `PageTools` it yields.
 */
export const skillsLayers = {
    bridges: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            return yield* makeSkills(db);
        }),
    ),
};
