// The context contract: the tags other features will reach `context/` through,
// the stores and functions that serve them today; the pure helpers moved to
// `@socio/foundation/context/*` and are imported from there (their old paths
// are gone).
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import {
    ChatNotes,
    ContextConfig,
    ContextFitting,
    DotReplies,
    Reactions,
    Steering,
    TimeMarkers,
    WaitingTurns,
} from '../src/server/context/contract.js';
import { contextFitting, compactNow, fitContext } from '../src/server/context/fit.js';
import { contextNotes } from '../src/server/context/notes.js';
import { dotReplies } from '../src/server/context/reaction-routes.js';
import { messageReactions } from '../src/server/context/reactions.js';
import { steeringQueue } from '../src/server/context/steering.js';
import { timeMarkers } from '../src/server/context/time-markers.js';
import { replayMessages } from '../src/server/replay/replay.js';

import { testDatabase } from './helpers/test-database.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
});

const database = () => {
    const db = testDatabase();
    databases.push(db);
    return db;
};

it('declares its tags under socio/context', () => {
    expect(
        [ChatNotes, TimeMarkers, ContextFitting, Steering, WaitingTurns, Reactions, DotReplies, ContextConfig].map(
            (tag) => tag.key,
        ),
    ).toEqual([
        'socio/context/ChatNotes',
        'socio/context/TimeMarkers',
        'socio/context/ContextFitting',
        'socio/context/Steering',
        'socio/context/WaitingTurns',
        'socio/context/Reactions',
        'socio/context/DotReplies',
        'socio/context/ContextConfig',
    ]);
});

it('fits with the moved functions', () => {
    expect(contextFitting.fit).toBe(fitContext);
    expect(contextFitting.compactNow).toBe(compactNow);
});

it('serves its tags from the stores of today', async () => {
    const db = database();
    const runner = { rowsMentioning: () => [] };
    const layer = Layer.mergeAll(
        Layer.succeed(ChatNotes, ChatNotes.of(contextNotes(db))),
        Layer.succeed(TimeMarkers, TimeMarkers.of(timeMarkers(db))),
        Layer.succeed(Steering, Steering.of(steeringQueue(db))),
        Layer.succeed(Reactions, Reactions.of(messageReactions(db))),
        Layer.succeed(DotReplies, DotReplies.of(dotReplies(runner, { messages: replayMessages }))),
        Layer.succeed(ContextFitting, ContextFitting.of(contextFitting)),
        Layer.succeed(ContextConfig, ContextConfig.of({ context: { selection: 'pointer' } })),
    );
    const read = await Effect.runPromise(
        Effect.gen(function* () {
            const steering = yield* Steering;
            const queued = yield* Effect.promise(() => steering.add('thread', 'person', 'one more thing', 1_000));
            const waiting = yield* Effect.promise(() => steering.list('thread', 'person'));
            const marker = (yield* TimeMarkers).mark('thread', 'message', 60_000);
            const reactions = yield* Reactions;
            reactions.add('thread', 'reply', 'person', 'up', { text: 'An answer' });
            const replies = yield* DotReplies;
            const reply = yield* Effect.promise(() => replies.find('thread', 'reply'));
            return {
                queued,
                waiting,
                marker,
                view: reactions.view('thread', 'person'),
                notes: (yield* ChatNotes).get('thread'),
                reply,
                config: (yield* ContextConfig).context,
            };
        }).pipe(Effect.provide(layer)),
    );
    expect(read.waiting).toEqual([read.queued]);
    expect(read.marker).toMatchObject({ messageId: 'message', toldAt: 60_000 });
    expect(read.view).toEqual({ reply: { counts: { up: 1 }, mine: ['up'] } });
    expect(read.notes).toBeUndefined();
    expect(read.reply).toBeUndefined();
    expect(read.config).toEqual({ selection: 'pointer' });
});
