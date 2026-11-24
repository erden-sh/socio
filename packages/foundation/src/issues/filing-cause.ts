/**
 * What started a turn that acts on the board, from the turn itself. Moved
 * from `issues/filing-tools.ts`, which re-exports it.
 */
import type { DotFilingTrigger } from '@socio/shared/issues/issue-types';

import type { DotTurn } from '../turns/turn.js';

/** A goal by its schedule's task (`GoalService.byTask`). */
export type GoalOfTask = (taskId: string) => Promise<{ id: string } | undefined> | { id: string } | undefined;

/**
 * What started the turn, from the turn itself, never from the model: a
 * goal's scheduled turn, another scheduled turn (its task), Telegram, a chat.
 */
export async function filingCause(
    turn: DotTurn,
    goalOf: GoalOfTask = () => undefined,
): Promise<{ trigger: DotFilingTrigger; causeId: string | null }> {
    if (turn.purpose === 'scheduled') {
        const task = turn.cause?.kind === 'schedule' ? turn.cause.id : null;
        const goal = task ? await goalOf(task) : undefined;
        return goal ? { trigger: 'goal', causeId: goal.id } : { trigger: 'scheduled', causeId: task };
    }
    return { trigger: turn.channel ? 'telegram' : 'chat', causeId: null };
}
