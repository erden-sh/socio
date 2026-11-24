import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';

import type { BoardVotes } from './contract.js';
import type { VoteRepository } from './domain/repositories.js';

/**
 * Upvotes on board items (CB-83): one live vote per person per item. A Dot
 * votes for the person it acts for, so that counts as the person's vote,
 * and the row records the Dot. Withdrawing stamps the row and keeps it;
 * voting again makes a new one.
 */
export class IssueVotes implements BoardVotes {
    constructor(
        private uow: UnitOfWork,
        private votes: VoteRepository,
    ) {}

    /** Whether the person has a live vote on the item. */
    async has(issueId: string, userId: string) {
        return !!(await this.votes.live(issueId, userId));
    }

    /**
     * The person's vote, cast by them or by `dotId` for them. Returns the
     * new vote's id, or undefined when they had voted already.
     */
    async cast(
        issueId: string,
        userId: string,
        dotId: string | null = null,
        now = Date.now(),
    ): Promise<string | undefined> {
        return this.uow.run(
            async () => {
                if (await this.votes.live(issueId, userId)) {
                    return undefined;
                }
                const id = randomUUID();
                await this.votes.insert({ id, issueId, userId, dotId, createdAt: now });
                return id;
            },
            { label: 'cast vote' },
        );
    }

    /** Withdraws the person's vote; the withdrawn vote's id, if there was one. */
    withdraw(issueId: string, userId: string, now = Date.now()) {
        return this.uow.run(
            async () => {
                const id = await this.votes.live(issueId, userId);
                if (!id) {
                    return undefined;
                }
                await this.votes.withdraw(id, now);
                return id;
            },
            { label: 'withdraw vote' },
        );
    }

    /** Live votes on one item. */
    count(issueId: string) {
        return this.votes.count(issueId);
    }

    /** Live votes by item, for items with any. */
    counts(): Promise<Map<string, number>> {
        return this.votes.counts();
    }

    /** The items the person has a live vote on. */
    mine(userId: string): Promise<Set<string>> {
        return this.votes.mine(userId);
    }
}
