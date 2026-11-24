import { Context, Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { Conversation, Dot } from '@socio/shared/types';

import type { AskBoardShape } from '../src/server/ask/contexts.js';
import { Ask, type AskShape } from '../src/server/ask/contract.js';
import { AskBoard, AskLive } from '../src/server/ask/layer.js';
import { askModule } from '../src/server/ask/module.js';
import { Data, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import type { ModuleContext } from '../src/server/modules/contract.js';
import { PageMoves, PageStore, type PageMovesShape, type PageStoreShape } from '../src/server/pages/contract.js';
import { Schedules, type SchedulesShape } from '../src/server/schedules/contract.js';
import { Access, type SpaceAccessShape } from '../src/server/spaces/contract.js';
import {
    Conversations,
    Socios,
    Spaces,
    type ConversationsShape,
    type SociosShape,
    type SpacesShape,
} from '../src/server/workspace/contract.js';

import { testDatabase } from './helpers/test-database.js';

// The panel's layer: `Ask` made once from the tags of what the panel reads,
// its threads added to the chats' pages, and the service the graph made read
// by the module's hooks (their services). No socio runs and nothing leaves the
// machine.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const dot = { id: 'd1', name: 'Mingo' } as Dot;

function layer() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const sources: Array<(threadId: string) => string | undefined> = [];
    const threads = new Map<string, Conversation>();
    const conversations = {
        thread: (id: string) => threads.get(id),
        bindThread: (id: string, dotId: string, title: string, ownerId: string) => {
            const thread = { id, dotId, title, ownerId } as Conversation;
            threads.set(id, thread);
            return thread;
        },
        addChatPages: (source: (threadId: string) => string | undefined) => sources.push(source),
    } as unknown as ConversationsShape;
    const deps = Layer.mergeAll(
        Layer.succeed(Data, {} as DataSpaceShape),
        Layer.succeed(Schedules, {} as SchedulesShape),
        Layer.succeed(AskBoard, {} as AskBoardShape),
        Layer.succeed(PageMoves, {} as PageMovesShape),
        Layer.succeed(PageStore, {} as PageStoreShape),
        Layer.succeed(Spaces, {} as SpacesShape),
        Layer.succeed(Access, {} as SpaceAccessShape),
        Layer.succeed(Socios, {
            canUseDot: (userId: string, dotId: string) => userId === 'u1' && dotId === dot.id,
            dotsFor: () => [dot],
        } as unknown as SociosShape),
        Layer.succeed(Conversations, conversations),
    );
    return { sources, live: AskLive({ db }).pipe(Layer.provide(deps)) };
}

describe('the ask layer', () => {
    it('makes the panel once from its tags, and adds its threads to the chats’ pages', async () => {
        const { live, sources } = layer();
        const built = await Effect.runPromise(Layer.build(live).pipe(Effect.scoped));
        const ask = Context.get(built, Ask);
        expect(sources).toHaveLength(1);

        const general = { kind: 'general' as const, id: '' };
        expect(await ask.lookup('u1', general)).toEqual({
            context: { kind: 'general', id: '', title: null, path: null },
            dotId: dot.id,
            conversation: null,
        });
        const opened = await ask.open('u1', general, dot.id);
        expect(opened.conversation).toMatchObject({ dotId: dot.id, ownerId: 'u1', title: 'Quick question' });
        // The same conversation the second time, and the socio remembered.
        expect((await ask.open('u1', general, dot.id)).conversation.id).toBe(opened.conversation.id);
        expect((await ask.lookup('u1', general)).conversation?.id).toBe(opened.conversation.id);
        // A general conversation is about no page.
        expect(sources[0](opened.conversation.id)).toBeUndefined();
        // Someone else's socio is missing, not forbidden.
        await expect(ask.open('u2', general, dot.id)).rejects.toMatchObject({ status: 404 });
    });

    it('gives the module’s hooks the service from their services', async () => {
        const calls: DotTurn[] = [];
        const ask = {
            turnNote: async (turn: DotTurn) => {
                calls.push(turn);
                return ' adopted';
            },
        } as AskShape;
        const turn = { threadId: 't1' } as DotTurn;
        const context = {
            services: { get: (tag: unknown) => (tag === Ask ? ask : undefined) },
        } as unknown as ModuleContext;
        expect(await askModule.dotTurnNote!(context, turn)).toBe(' adopted');
        expect(calls).toEqual([turn]);
    });
});
