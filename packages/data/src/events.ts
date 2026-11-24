import { setImmediate } from 'node:timers';

import type { UnitOfWork } from './uow.js';

type Handler<Event> = (event: Event) => void | Promise<void>;

/**
 * A context's domain events (CB-110), the one seam between the code
 * that raises them and the code that reacts. Today they are delivered in
 * this process after the unit of work that raised them commits (never on a
 * rollback); an outbox can later take `publish` over, writing each event
 * in that same transaction, without touching producers or subscribers.
 */
export interface DomainEvents<Events extends Record<string, unknown>> {
    /** Raised inside a unit of work; delivered once it commits. */
    publish<Type extends keyof Events>(type: Type, event: Events[Type]): void;
    /** Called with each such event, in the order subscribed; returns the unsubscribe. */
    subscribe<Type extends keyof Events>(type: Type, handler: Handler<Events[Type]>): () => void;
}

/**
 * Delivery after commit, in this process. A handler that fails is
 * `failed`'s to report; the others still run, and the change stays saved.
 */
export function afterCommitEvents<Events extends Record<string, unknown>>(
    uow: UnitOfWork,
    failed: (type: keyof Events, error: unknown) => void,
): DomainEvents<Events> {
    const handlers = new Map<keyof Events, Set<Handler<never>>>();
    return {
        publish(type, event) {
            uow.afterCommit(async () => {
                for (const handler of [...(handlers.get(type) ?? [])]) {
                    try {
                        await (handler as Handler<typeof event>)(event);
                    } catch (error) {
                        failed(type, error);
                    }
                }
            });
        },
        subscribe(type, handler) {
            if (!handlers.has(type)) {
                handlers.set(type, new Set());
            }
            handlers.get(type)!.add(handler as Handler<never>);
            return () => {
                handlers.get(type)?.delete(handler as Handler<never>);
            };
        },
    };
}

/**
 * Waits for the next turn of the event loop. A subscriber that starts work
 * of its own (one not awaited by the publisher: a triage, a cancel) waits
 * for it first, so its units of work never open in the turn that carries
 * on with the publisher's caller, such as the next tool call (CB-110).
 */
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
