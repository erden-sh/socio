import { randomUUID } from 'node:crypto';

import { PageError } from '@socio/foundation/pages/page-error';
import { messageText } from '@socio/foundation/turns/media-parts';

import type { RunnerShape } from '../turns/contract.js';

import type { PageConversationsShape } from './contract.js';
import type { PagesWorkspace } from './slices.js';

/** Thread history for page conversations, provided by the platform. */
export interface PageThreads {
    getOrCreateThread(input: { threadId: string; userId: string; agentId: string; name: string }): Promise<unknown>;
    getThreadMessages(input: {
        threadId: string;
        userId: string;
    }): Promise<{ messages: { role: string; content?: unknown }[] }>;
}
/**
 * Thread history from the turn runner: page conversations are bound
 * locally by `PageService`, and the runner creates history on the first
 * run.
 */
export function runnerThreads(runner: Pick<RunnerShape, 'messages'>): PageThreads {
    return {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async ({ threadId }) => ({
            messages: await runner.messages(threadId),
        }),
    };
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Conversation request timed out. Retry to recover the same conversation.')),
                    30000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
export class PageService implements PageConversationsShape {
    private pending = new Map<string, Promise<ReturnType<PagesWorkspace['requireThread']>>>();
    constructor(
        private workspace: PagesWorkspace,
        private threads: PageThreads,
    ) {}
    /** The user's conversation about a page with a Dot, created on first use. */
    async conversation(spaceId: string, pageId: string, dotId: string, userId: string) {
        const page = this.workspace.pages.get(spaceId, pageId);
        const dot = this.workspace.dot(dotId);
        if (
            !dot ||
            !this.workspace.canUseDot(userId, dotId) ||
            // The socio must have the Space, and its person read it (CB-181).
            !this.workspace.spaceAccess.reads(spaceId, { dotId, people: [userId] })
        ) {
            throw new PageError('Choose a specialist in this Space with access enabled.', 400);
        }
        const key = `${pageId}:${dotId}:${userId}`;
        const pending = this.pending.get(key);
        if (pending) {
            return pending;
        }
        const current = this.workspace.pages.thread(pageId, dotId, userId);
        if (current?.ready) {
            return this.workspace.requireOwnedThread(userId, current.threadId, dotId);
        }
        const sdk = this.threads;
        const task = (async () => {
            const candidateId = randomUUID();
            if (!(await this.workspace.pages.reserveThread(pageId, dotId, userId, candidateId))) {
                throw new PageError('This page conversation is being created. Retry shortly.', 409);
            }
            const threadId = this.workspace.pages.thread(pageId, dotId, userId)!.threadId;
            try {
                await bounded(
                    sdk.getOrCreateThread({
                        threadId,
                        userId,
                        agentId: dotId,
                        name: page.title,
                    }),
                );
                if (
                    !this.workspace.spaceAccess.reads(spaceId, {
                        dotId,
                        people: [userId],
                    })
                ) {
                    throw new PageError('Space access has been revoked.');
                }
                const thread =
                    this.workspace.thread(threadId) ?? this.workspace.bindThread(threadId, dotId, page.title, userId);
                await this.workspace.pages.finishThread(pageId, dotId, userId);
                return thread;
            } catch (error) {
                await this.workspace.pages.releaseThread(pageId, dotId, userId);
                throw error;
            }
        })();
        this.pending.set(key, task);
        try {
            return await task;
        } finally {
            this.pending.delete(key);
        }
    }
    async saveConversation(threadId: string, title: string, parentId: string | null) {
        const thread = this.workspace.requireThread(threadId);
        const dot = this.workspace.dot(thread.dotId)!;
        const history = await bounded(
            this.threads.getThreadMessages({
                threadId,
                userId: thread.ownerId,
            }),
        );
        const chunks: string[] = [];
        for (const message of history.messages) {
            if (!['user', 'assistant'].includes(message.role)) {
                continue;
            }
            // Attachments as `[attachment: name]`, never their bytes.
            const text = messageText(message.content);
            if (text.trim()) {
                chunks.push(`## ${message.role === 'user' ? 'You' : 'Socio'}\n\n${text}`);
            }
        }
        const content = chunks.join('\n\n');
        if (!content) {
            throw new PageError('This conversation has no persisted text to save.');
        }
        if (content.length > 100000) {
            throw new PageError(
                'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.',
            );
        }
        const destination = this.workspace.pages.forThread(threadId)?.spaceId ?? dot.spaceId;
        if (!this.workspace.socioReads(threadId, destination, dot.id)) {
            throw new PageError('Space access has been revoked.', 400);
        }
        return this.workspace.pages.create(destination, { title, content, parentId }, threadId, thread.ownerId);
    }
}
