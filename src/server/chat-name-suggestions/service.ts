// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { messageText } from '@socio/foundation/turns/media-parts';

import type { EndpointSource } from '../inference/contract.js';
import type { RunnerShape, RunStatus } from '../turns/contract.js';
import type { ConversationsShape } from '../workspace/contract.js';

import type { ChatNamesShape, ChatNameSuggestionRepository } from './contract.js';
import { suggestChatName } from './naming.js';
import { DRIFT_WINDOW_MESSAGES, evaluateNameTrigger } from './triggers.js';

/**
 * The content-based name-suggestion service (CB-292). Attached to the
 * runner's `onRunFinished`, it evaluates the cheap triggers (unnamed or
 * keyword-overlap drift) after each turn and, only when one fires, asks the
 * model (via the existing title-gen path) for a concise name and stores a
 * single pending suggestion per chat. No name is applied without explicit
 * approval; rejection enforces a K=30 message cooldown.
 *
 * The service never throws on the turn's path: a failure to suggest is
 * reported and dropped, so the conversation is unaffected.
 */
export class ChatNameSuggestions implements ChatNamesShape {
    private pending = new Set<Promise<void>>();
    private inFlight = new Set<string>();
    private stopping = new AbortController();
    private now: () => number;

    constructor(
        private workspace: ConversationsShape,
        private runner: RunnerShape,
        private endpoint: EndpointSource,
        private repo: ChatNameSuggestionRepository,
        private log: (line: string) => void = () => undefined,
        private fetchImpl: typeof fetch = (...args) => fetch(...args),
        /**
         * Whether the feature is on (CB-292): an admin's switch from Settings,
         * off by default. The cheap triggers still run, but no model call is
         * made and no suggestion stored while it is off. Tests that exercise
         * the service pass `() => true` to bypass the switch.
         */
        private enabled: () => boolean = () => true,
        now: () => number = Date.now,
    ) {
        this.now = now;
    }

    attach() {
        this.runner.onRunFinished((threadId, status) => void this.onRun(threadId, status));
    }

    /** Resolves when suggestions requested so far have settled (for tests). */
    async idle() {
        await Promise.all(this.pending);
    }

    /** Asks for no more suggestions and cancels one in flight. */
    async stop() {
        this.stopping.abort();
        await this.idle();
    }

    /** The pending suggestion for a chat, if any (any status row kept). */
    suggestion(threadId: string) {
        return this.repo.get(threadId);
    }

    private async onRun(threadId: string, status: RunStatus) {
        if (status !== 'finished' || this.stopping.signal.aborted) {
            return;
        }
        const thread = this.workspace.thread(threadId);
        if (!thread) {
            return;
        }
        if (this.inFlight.has(threadId)) {
            return;
        }
        this.inFlight.add(threadId);
        const task = this.consider(threadId, thread.title)
            .catch((error) => {
                if (!this.stopping.signal.aborted) {
                    this.log(
                        `Chat names: suggestion failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
                    );
                    reportFailure('Chat name suggestion', [safeFailure(error)]);
                }
            })
            .finally(() => {
                this.inFlight.delete(threadId);
                this.pending.delete(task);
            });
        this.pending.add(task);
    }

    private async consider(threadId: string, title: string) {
        if (this.stopping.signal.aborted || !this.enabled()) {
            return;
        }
        const messages = await this.runner.messages(threadId);
        const count = messages.length;
        const recentTexts = messages.slice(-DRIFT_WINDOW_MESSAGES).map((m) => messageText(m.content));
        const existing = this.repo.get(threadId);
        const lastRejectedAt = existing?.rejectedAtMessageIndex ?? -1;
        const pending = !!existing && existing.status === 'pending';
        const verdict = evaluateNameTrigger({
            title,
            messageCount: count,
            recentTexts,
            lastRejectedAt,
            pending,
        });
        if (!verdict) {
            return;
        }
        if (this.stopping.signal.aborted) {
            return;
        }
        const name = await suggestChatName(messages, this.endpoint, this.fetchImpl, this.stopping.signal);
        if (!name || this.stopping.signal.aborted) {
            return;
        }
        this.repo.insert({
            threadId,
            suggestedName: name,
            trigger: verdict.trigger,
            status: 'pending',
            suggestedAtMessageIndex: count,
            rejectedAtMessageIndex: existing?.rejectedAtMessageIndex ?? -1,
            createdAt: this.now(),
            settledAt: null,
        });
    }
}
