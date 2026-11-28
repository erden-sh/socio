import { useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { GOAL_COMMENT_MAX, type GoalView } from '@socio/shared/schedule-types';

import { api } from '../../lib/api';

import { When } from './schedule-words';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * A goal's comment thread (CB-135): what the person and the Dot added to
 * it, oldest first, and a box for the person to add more while the goal is
 * open. The Dot reads them in its goal turns.
 */
export function GoalComments({ goal, dotName, onPosted }: { goal: GoalView; dotName: string; onPosted: () => void }) {
    const { t } = useTranslation(['schedules']);
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
            toast.error(e instanceof Error ? e.message : t('schedules:comments.failed'));
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
                                {comment.author === 'person' ? t('schedules:comments.you') : dotName} ·{' '}
                                <When value={comment.createdAt} />
                            </span>
                            <span className="whitespace-pre-wrap break-words">{comment.body}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-muted-foreground">{t('schedules:comments.none')}</p>
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
                        aria-label={t('schedules:comments.label')}
                        placeholder={t('schedules:comments.placeholder', { name: dotName })}
                        value={draft}
                        rows={2}
                        maxLength={GOAL_COMMENT_MAX}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="flex justify-end">
                        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
                            {t('schedules:comments.submit')}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
