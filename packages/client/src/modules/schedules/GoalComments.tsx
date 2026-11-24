import { useState } from 'react';
import { toast } from 'sonner';

import { GOAL_COMMENT_MAX, type GoalView } from '@socio/shared/schedule-types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const when = (t: number) =>
    new Date(t).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

/**
 * A goal's comment thread (CB-135): what the person and the Dot added to
 * it, oldest first, and a box for the person to add more while the goal is
 * open. The Dot reads them in its goal turns.
 */
export function GoalComments({ goal, dotName, onPosted }: { goal: GoalView; dotName: string; onPosted: () => void }) {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const open = goal.status === 'active' || goal.status === 'paused';
    const post = async () => {
        setBusy(true);
        try {
            await api(`/schedules/goals/${encodeURIComponent(goal.id)}/comments`, 'POST', { body: draft });
            setDraft('');
            onPosted();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not add the comment.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="grid gap-2" data-slot="goal-comments">
            {goal.comments.length ? (
                <ul className="grid gap-2">
                    {goal.comments.map((comment) => (
                        <li
                            key={comment.id}
                            data-slot="goal-comment"
                            className="grid gap-0.5 rounded-lg border px-3 py-2 text-sm"
                        >
                            <span className="text-xs text-muted-foreground">
                                {comment.author === 'person' ? 'You' : dotName} ·{' '}
                                <LocalTime value={comment.createdAt} format={when} />
                            </span>
                            <span className="whitespace-pre-wrap break-words">{comment.body}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
            )}
            {open && (
                <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (draft.trim()) {
                            void post();
                        }
                    }}
                >
                    <Textarea
                        aria-label="Add a comment"
                        placeholder={`Add context or a changed requirement for ${dotName}`}
                        value={draft}
                        rows={2}
                        maxLength={GOAL_COMMENT_MAX}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="flex justify-end">
                        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
                            Comment
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
