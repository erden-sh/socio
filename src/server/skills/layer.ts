/**
 * Chat skills' layer: the workspace's skills and the skill each person has on
 * in each chat (one repository each per connection, the same instances the
 * module's hooks, the socios and Telegram use), the registry over them,
 * `/compact` over the context's fitting, and `/unfurl`'s tools over the socio's
 * page tools. It needs `ContextFitting`, `PageTools` and `Approvals`, which the
 * composition provides. Only the composition (`composition/skills.ts`) and
 * tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Approvals } from '../approvals/contract.js';
import { ContextFitting } from '../context/contract.js';
import { PageTools } from '../pages/contract.js';

import { compactWith } from './compact.js';
import { Compact, SkillRegistry, SkillSessions, UnfurlTools, WorkspaceSkills } from './contract.js';
import { chatSkills } from './registry.js';
import { skillSessions, skillsRepository } from './repository.js';
import { unfurlToolsOver } from './services.js';
import { registerUnfurlApprovals } from './unfurl-recursive.js';

/** Every skills tag on `db`, over the `ContextFitting`, `PageTools` and `Approvals` tags. */
export const makeSkills = (db: DatabaseSync) =>
    Effect.gen(function* () {
        const fitting = yield* ContextFitting;
        const pages = yield* PageTools;
        // A large recursive unfurl asks the person on a card (CB-492).
        const approvals = yield* Approvals;
        registerUnfurlApprovals(approvals);
        const repository = skillsRepository(db);
        const sessions = skillSessions(db);
        return Context.make(WorkspaceSkills, repository).pipe(
            Context.add(SkillSessions, sessions),
            Context.add(SkillRegistry, chatSkills(repository, sessions)),
            Context.add(Compact, compactWith(fitting)),
            Context.add(UnfurlTools, unfurlToolsOver(pages, approvals)),
        );
    });

/**
 * `WorkspaceSkills`, `SkillSessions`, `SkillRegistry`, `Compact` and
 * `UnfurlTools`, built once over `db`; needs `ContextFitting`, `PageTools` and `Approvals`.
 */
export const SkillsLive = (db: DatabaseSync) => Layer.effectContext(makeSkills(db));
