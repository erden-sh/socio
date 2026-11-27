import { ArchiveRestore } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { DeletedSpace } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { PrivateSpaceIcon } from '@/components/private-space';
import { Button } from '@/components/ui/button';

/**
 * Settings → Deleted Spaces (CB-277, admins): each deleted Space, who
 * deleted it and when, and Restore, which brings it back with everything
 * in it, for the people who could see it. Deleted Spaces are kept until
 * an admin restores them; nothing purges them.
 */
export function DeletedSpacesSection() {
    const { t } = useTranslation(['settings.deleted-spaces']);
    /** "Oct 12, 2026, 3:04 PM", in the reader's words once hydrated. */
    const when = (at: number) => t('settings.deleted-spaces:item.when', { at: new Date(at) });
    const shell = useShell();
    const [spaces, setSpaces] = useState<DeletedSpace[]>();
    const [restoring, setRestoring] = useState<string>();
    const load = useCallback(async () => {
        try {
            setSpaces((await api<{ spaces: DeletedSpace[] }>('/admin/spaces/deleted')).spaces);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('settings.deleted-spaces:errors.load'));
        }
    }, [t]);
    useEffect(() => {
        void load();
    }, [load]);
    const restore = async (space: DeletedSpace) => {
        setRestoring(space.id);
        try {
            await api(`/admin/spaces/${encodeURIComponent(space.id)}/restore`, 'POST');
            toast.success(t('settings.deleted-spaces:restore.done', { name: space.name }));
            setSpaces((list) => list?.filter((item) => item.id !== space.id));
            await shell.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('settings.deleted-spaces:errors.restore'));
        } finally {
            setRestoring(undefined);
        }
    };
    return (
        <section className="grid gap-2" data-slot="deleted-spaces">
            <h3 className="font-medium">{t('settings.deleted-spaces:title')}</h3>
            <p className="text-muted-foreground">{t('settings.deleted-spaces:description')}</p>
            {!spaces ? (
                <p className="text-xs text-muted-foreground">{t('settings.deleted-spaces:loading')}</p>
            ) : spaces.length === 0 ? (
                <p className="text-muted-foreground" data-slot="deleted-spaces-empty">
                    {t('settings.deleted-spaces:empty')}
                </p>
            ) : (
                <ul className="grid gap-2" aria-label={t('settings.deleted-spaces:title')}>
                    {spaces.map((space) => (
                        <li
                            key={space.id}
                            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2"
                        >
                            <div className="grid min-w-0 flex-1 gap-0.5">
                                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                                    <span className="min-w-0 break-words">{space.name}</span>
                                    {space.private && <PrivateSpaceIcon className="size-3.5 flex-none" />}
                                </span>
                                <small className="text-xs text-muted-foreground">
                                    <Trans
                                        t={t}
                                        i18nKey="settings.deleted-spaces:item.deleted"
                                        count={space.pages}
                                        values={{
                                            name: space.deletedByName ?? t('settings.deleted-spaces:item.formerMember'),
                                        }}
                                        components={{ when: <LocalTime value={space.deletedAt} format={when} /> }}
                                    />
                                </small>
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={restoring !== undefined}
                                aria-label={t('settings.deleted-spaces:restore.label', { name: space.name })}
                                onClick={() => void restore(space)}
                            >
                                <ArchiveRestore className="size-4" aria-hidden />
                                {restoring === space.id
                                    ? t('settings.deleted-spaces:restore.busy')
                                    : t('settings.deleted-spaces:restore.action')}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
