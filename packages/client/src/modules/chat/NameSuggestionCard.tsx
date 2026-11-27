import { useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';

import {
    acceptNameSuggestion,
    customizeNameSuggestion,
    rejectNameSuggestion,
    type NameSuggestion,
} from './chat-name-suggestions';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The inline name-suggestion card (CB-292): a proposed, content-based name
 * for a chat, with accept / reject / customize. No name is applied without
 * explicit approval. Shown while a suggestion is pending.
 */
export function NameSuggestionCard({
    threadId,
    suggestion,
    onApplied,
    onSettled,
}: {
    threadId: string;
    suggestion: NameSuggestion;
    /** Called with the new title after accept/customize so the header updates. */
    onApplied?: (title: string) => void;
    /** Called after any settle (accept/reject/customize) to refetch state. */
    onSettled?: () => void;
}) {
    const { t } = useTranslation(['chat.composer']);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(suggestion.suggestedName);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const settle = async (work: () => Promise<unknown>, then?: () => void) => {
        setBusy(true);
        setError(null);
        try {
            await work();
            then?.();
            onSettled?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('chat.composer:name-suggestion.failed'));
            setBusy(false);
        }
    };

    const accept = () =>
        settle(async () => {
            const { title } = await acceptNameSuggestion(threadId);
            onApplied?.(title);
        });

    const reject = () => settle(() => rejectNameSuggestion(threadId));

    const customize = () =>
        settle(async () => {
            const name = draft.trim();
            if (!name) {
                setError(t('chat.composer:name-suggestion.empty'));
                return;
            }
            const { title } = await customizeNameSuggestion(threadId, name);
            onApplied?.(title);
            setEditing(false);
        });

    if (editing) {
        return (
            <div className={cn('flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-sm')}>
                <input
                    className="w-full rounded border bg-background px-2 py-1 text-sm"
                    value={draft}
                    maxLength={80}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    aria-label={t('chat.composer:name-suggestion.field')}
                />
                {error && <p className="text-destructive text-xs">{error}</p>}
                <div className="flex gap-2">
                    <Button size="sm" onClick={customize} disabled={busy}>
                        {t('chat.composer:name-suggestion.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                        {t('chat.composer:name-suggestion.cancel')}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className={cn('flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-sm')}>
            <p className="text-muted-foreground">
                <Trans
                    t={t}
                    i18nKey="chat.composer:name-suggestion.text"
                    values={{ name: suggestion.suggestedName }}
                    components={{ name: <strong className="text-foreground" /> }}
                />
            </p>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={accept} disabled={busy}>
                    {t('chat.composer:name-suggestion.accept')}
                </Button>
                <Button size="sm" variant="ghost" onClick={reject} disabled={busy}>
                    {t('chat.composer:name-suggestion.reject')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
                    {t('chat.composer:name-suggestion.customize')}
                </Button>
            </div>
        </div>
    );
}
