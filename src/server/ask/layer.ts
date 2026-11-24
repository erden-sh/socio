/**
 * The "Ask a socio" panel's layer: it implements `contract.ts`. Only the
 * composition root and tests import this file.
 *
 * The service is made once, from the tags of what it reads: the data space
 * (`Data`), schedules (`Schedules`), the Board (`Board`), page moves
 * (`PageMoves`), the workspace's pages (`PageStore`) and slices (`Spaces`,
 * `Socios`, `Conversations`), and Space access (`Access`). Its rows are on
 * the workspace connection it is handed. Nothing is started and nothing is
 * read from the database here: the panel only adds its threads to the
 * chats' pages, as the module did when it made the service.
 *
 * The Board sits above ask in the folder order (scripts/feature-ranks.json),
 * so the panel reads it through its own tag, `AskBoard` (typed by
 * `AskBoardShape`, `contexts.ts`), which the composition root provides
 * over the issues' `Board` (`composition/ask.ts`).
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Data } from '../dataspace/contract.js';
import { PageMoves, PageStore } from '../pages/contract.js';
import { Schedules } from '../schedules/contract.js';
import { Access } from '../spaces/contract.js';
import { Conversations, Socios, Spaces } from '../workspace/contract.js';

import type { AskBoardShape } from './contexts.js';
import { Ask } from './contract.js';
import { makeAskService } from './service.js';

/** The Board, as the panel reads it (see above). */
export class AskBoard extends Context.Service<AskBoard, AskBoardShape>()('socio/ask/AskBoard') {}

/** What the panel is made on: the workspace connection (its tables, migrated at boot). */
export interface AskBoot {
    db: DatabaseSync;
}

/** The panel's service, over its tags. */
export const askService = (boot: AskBoot) =>
    Effect.gen(function* () {
        return makeAskService({
            db: boot.db,
            data: yield* Data,
            schedules: yield* Schedules,
            board: yield* AskBoard,
            pageMoves: yield* PageMoves,
            pages: yield* PageStore,
            spaces: yield* Spaces,
            spaceAccess: yield* Access,
            socios: yield* Socios,
            conversations: yield* Conversations,
        });
    });

/** `Ask`, made once. */
export const AskLive = (boot: AskBoot) => Layer.effect(Ask, askService(boot));
