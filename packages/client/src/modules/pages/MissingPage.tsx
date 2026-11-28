import { FileX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { api, ApiError } from '../../lib/api';
import { useCrumbTitle } from '../../shell/crumb-title';

import { LibraryEmpty, PagePrimaryButton } from './page-chrome';

/**
 * A page address whose page isn't in the Space's list: still loading, a
 * page that was deleted (a link to it says so, rather than an error), one
 * that moved to another Space (CB-142: it opens there), or one that never
 * existed here. The server keeps a tombstone of deleted page ids and
 * answers 410 for them.
 */
export function MissingPage({
    spaceId,
    pageId,
    loaded,
    deleted,
    onHome,
    onMoved,
}: {
    spaceId: string;
    pageId: string;
    /** The Space's page list has loaded. */
    loaded: boolean;
    /** Deleted in this view, so there is nothing to ask. */
    deleted: boolean;
    onHome: () => void;
    /** Opens the page in the Space it moved to. */
    onMoved: (spaceId: string, pageId: string) => void;
}) {
    const { t } = useTranslation(['pages']);
    const moved = useRef(onMoved);
    useEffect(() => {
        moved.current = onMoved;
    });
    const [state, setState] = useState<'checking' | 'deleted' | 'missing'>(deleted ? 'deleted' : 'checking');
    useEffect(() => {
        if (!loaded || deleted) {
            return;
        }
        const controller = new AbortController();
        api(
            `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`,
            'GET',
            undefined,
            controller.signal,
        )
            // It exists after all (created since the last poll): the next poll
            // brings it, so keep showing "Loading".
            .then(() => setState('checking'))
            .catch(async (error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                if (error instanceof ApiError && error.status === 410) {
                    return setState('deleted');
                }
                // Not here: maybe it moved, and an old link led here.
                const found = await api<{ spaceId: string }>(
                    `/pages/${encodeURIComponent(pageId)}/location`,
                    'GET',
                    undefined,
                    controller.signal,
                ).catch(() => undefined);
                if (controller.signal.aborted) {
                    return;
                }
                if (found && found.spaceId !== spaceId) {
                    return moved.current(found.spaceId, pageId);
                }
                setState('missing');
            });
        return () => controller.abort();
    }, [spaceId, pageId, loaded, deleted]);
    const shown = deleted ? 'deleted' : loaded ? state : 'checking';
    // The breadcrumb says "Deleted page"; otherwise a key that matches no
    // page leaves it at "Pages".
    useCrumbTitle(shown === 'deleted' ? pageId : '', t('pages:missing.crumb'));
    if (shown === 'checking') {
        return <LibraryEmpty title={t('pages:missing.loading')} />;
    }
    return (
        <LibraryEmpty
            role="status"
            icon={<FileX size={30} strokeWidth={1.3} />}
            title={shown === 'deleted' ? t('pages:missing.deleted') : t('pages:missing.not-found')}
            action={<PagePrimaryButton onClick={onHome}>{t('pages:missing.back')}</PagePrimaryButton>}
        >
            {shown === 'deleted' ? t('pages:missing.deleted-detail') : t('pages:missing.not-found-detail')}
        </LibraryEmpty>
    );
}
