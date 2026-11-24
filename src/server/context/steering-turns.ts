import { randomUUID } from 'node:crypto';

import type { Message } from '@ag-ui/client';

import { senderMetadata, senderOf, type MessageSender } from '@socio/foundation/workspace/client-messages';
import type { QueuedMessage } from '@socio/shared/chat/steering';
import { compareText } from '@socio/shared/locale';

import type { WaitingTurnsShape, SteeringQueue } from './contract.js';
import type { SteeringTurnSources } from './sources.js';

/**
 * A queued message as the person's message in the conversation, from
 * `sender` who queued it (CB-228): its text, or (with attachments, CB-223)
 * its text and their references, as the chat sends a message with
 * attachments; the turn reads them as it reads those.
 */
export const queuedMessage = ({ id, text, attachments }: QueuedMessage, sender: MessageSender): Message =>
    ({
        id,
        role: 'user',
        metadata: senderMetadata(sender),
        content: attachments?.length
            ? [
                  ...(text.trim() ? [{ type: 'text' as const, text }] : []),
                  ...attachments.map((ref) => ({
                      type: 'binary' as const,
                      id: ref.id,
                      mimeType: ref.mediaType,
                      filename: ref.name,
                  })),
              ]
            : text,
    }) as Message;

/**
 * Steering messages a turn ended before taking (CB-151) start the next
 * turn: the server runs it, as the person's own, once their turn ends, or
 * at once when they sent one with no turn running. The chat follows it,
 * as it follows a Dot carrying on after an approval (CB-58). A turn the
 * person stopped ends that way too: Stop never drops what waits, which
 * goes next, in order, once (CB-170); so does a turn that hit its time
 * limit or failed. Not after a turn that waits for the person (a review
 * or an approval: the turn that carries on takes them), nor one an
 * operator or a restart ended; not while Socio is paused or a restart is
 * coming. What waits then is taken by the next turn, at the next start or
 * when Socio is resumed (`resume`). A turn started here that ends before
 * it stores them (no model for the person, say) puts them back for the
 * next turn, and starts none with them now.
 *
 * Each person's waiting messages are their own work cycle (CB-211): the
 * turn started with them runs as the person who queued
 * them, the oldest waiting first, and only while they may still send
 * there (`WorkCycles.mayDispatch`, checked as they are taken): in a
 * private chat its owner; in a room, once rooms come, an active member.
 * Anyone else's wait, untouched. The queue counted them for the chat's
 * rate as they were queued, so their turn doesn't again.
 *
 * Web chats only: a Telegram conversation has no steering queue.
 */
export class SteeringTurns implements WaitingTurnsShape {
    private queue: SteeringQueue;
    private stopped = false;
    /** What each turn started here took, by run id, until it ends. */
    private taken = new Map<string, { threadId: string; userId: string; messages: QueuedMessage[] }>();
    constructor(private sources: SteeringTurnSources) {
        this.queue = sources.queue;
        sources.runner.onRunFinished((threadId, status, run) => {
            // A turn of ours that failed or was stopped before its RUN_STARTED
            // stored them: they go back to the queue, and wait (starting another
            // turn would only fail the same way).
            const taken = this.taken.get(run.runId);
            this.taken.delete(run.runId);
            if (taken) {
                const known = sources.runner.knownMessageIds(threadId);
                const unsent = taken.messages.filter(({ id }) => !known.has(id));
                if (unsent.length) {
                    this.queue.restore(threadId, taken.userId, unsent).catch(() => undefined);
                    return;
                }
            }
            if (status === 'interrupted' || run.trace.end?.reason === 'interrupted') {
                return;
            }
            void this.consider(threadId);
        });
    }
    /**
     * The run id of the turn started here in the conversation, while it
     * runs: the chat follows it when it missed its start (CB-170).
     */
    turn(threadId: string): string | undefined {
        const runId = this.sources.runner.activeRunId(threadId);
        return runId && this.taken.get(runId)?.threadId === threadId ? runId : undefined;
    }
    /** At start, and when Socio is resumed: what waits since. */
    async resume() {
        try {
            for (const { threadId } of await this.queue.waiting()) {
                await this.consider(threadId);
            }
        } catch {
            this.sources.log('Steering: could not start the turns left waiting.');
        }
    }
    stop() {
        this.stopped = true;
    }
    /**
     * Starts a turn with the conversation's waiting messages when none runs
     * there; whether it did. Never fails its caller.
     */
    async consider(threadId: string): Promise<boolean> {
        try {
            return await this.next(threadId);
        } catch {
            return false;
        }
    }
    private async next(threadId: string) {
        const { runner, conversations, socios, people, links, settings } = this.sources;
        const idle = () =>
            !this.stopped && !this.sources.draining() && !runner.activeRunId(threadId) && !settings.settings().paused;
        if (!idle()) {
            return false;
        }
        const thread = conversations.thread(threadId);
        const dot = thread && socios.dot(thread.dotId);
        if (!thread || !dot || dot.archivedAt) {
            return false;
        }
        if (await links.threadInfo(threadId)) {
            return false;
        }
        if ((await this.sources.setup()).missing.length) {
            return false;
        }
        // A room's socio that answers next in the cycle before (CB-206) goes
        // first: its end is another chance to look.
        const { orchestrator } = this.sources;
        if (thread.kind === 'room' && (await orchestrator.waiting(threadId))) {
            return false;
        }
        const author = await this.nextAuthor(threadId);
        if (!author) {
            return false;
        }
        const taken = await this.queue.take(threadId, author);
        if (!taken.length) {
            return false;
        }
        // Theirs, as they queued them (CB-228); their turn acts for them when
        // they are not the chat's owner (a room's member).
        const sender = senderOf(people.users(), author);
        const messages = taken.map((message) => queuedMessage(message, sender));
        // Who answers (CB-206): in a room the socios the messages name, in
        // order, as far as the cycle's handoffs reach, else the lead; else
        // the chat's own socio.
        const handoffs = thread.kind === 'room' ? (await this.sources.cycles.limitsFor(threadId)).handoffsPerCycle : 0;
        const targets = orchestrator
            .route(
                threadId,
                taken.map((message) => message.text),
            )
            .slice(0, handoffs + 1);
        const dotId = targets[0];
        if (!dotId || !socios.dot(dotId) || socios.dot(dotId)!.archivedAt) {
            await this.queue.restore(threadId, author, taken);
            return false;
        }
        // Out of the queue, their files are no longer held there: claimed for
        // this chat at once, as a sent message's are when its run is accepted
        // (CB-223), so neither the cleanup of unsent ones nor a turn that fails
        // before it reads them leaves them to be deleted. Before the check
        // below, so nothing awaits between it and the turn's start; put back,
        // they stay claimed for this chat, where they wait.
        await this.sources.media
            .bindNew({ userId: author, dotId, threadId }, messages, new Set())
            .catch(() => undefined);
        // The further socios they named answer after this turn, in its cycle
        // (stored before the check below, which nothing may await after).
        const runId = randomUUID();
        if (targets.length > 1) {
            await orchestrator.queueNamed(threadId, runId, author, targets);
        }
        // A turn started meanwhile: it takes them.
        if (!idle()) {
            await orchestrator.dropAfter(runId, 'not_started');
            await this.queue.restore(threadId, author, taken);
            return false;
        }
        const agent = this.sources.agents.agent({
            dotId,
            channel: false,
            actingUserId: author === thread.ownerId ? undefined : author,
        });
        agent.threadId = threadId;
        agent.setMessages(messages);
        this.taken.set(runId, { threadId, userId: author, messages: taken });
        try {
            // The runner puts the stored conversation before them and stores
            // the turn; its end is another chance to look (above).
            runner
                .run({
                    threadId,
                    agent,
                    // Their waiting messages start it, a work cycle of theirs
                    // (CB-211); its queue time runs from the first (CB-185).
                    signals: {
                        receivedAt: Math.min(...taken.map((message) => message.createdAt)),
                        trigger: { kind: 'person', id: author },
                        queued: true,
                    },
                    input: {
                        threadId,
                        runId,
                        messages,
                        state: {},
                        tools: [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .subscribe({ error: () => undefined });
        } catch {
            this.taken.delete(runId);
            await orchestrator.dropAfter(runId, 'not_started');
            await this.queue.restore(threadId, author, taken);
            return false;
        }
        return true;
    }
    /**
     * Whose waiting messages go next in the conversation: the person whose
     * oldest one waits longest, of those who may still start work there.
     */
    private async nextAuthor(threadId: string) {
        const waiting = (await this.queue.waiting()).filter((entry) => entry.threadId === threadId);
        const oldest: { userId: string; at: number }[] = [];
        for (const { userId } of waiting) {
            const messages = await this.queue.list(threadId, userId);
            if (messages.length) {
                oldest.push({
                    userId,
                    at: Math.min(...messages.map((message) => message.createdAt)),
                });
            }
        }
        oldest.sort((a, b) => a.at - b.at || compareText(a.userId, b.userId));
        for (const { userId } of oldest) {
            if (await this.sources.cycles.mayDispatch(threadId, userId)) {
                return userId;
            }
        }
        return undefined;
    }
}
