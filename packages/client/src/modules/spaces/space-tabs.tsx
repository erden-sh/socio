import { NavLink } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { Space } from '@socio/shared/types';

import { spacePath } from '../pages/page-navigation';

import { PrivateSpaceIcon } from '@/components/private-space';
import { cn } from '@/lib/utils';

/** Where a Space's shared memory is (CB-181). */
export const spaceMemoryPath = (spaceId: string) => `${spacePath(spaceId)}/memory`;

/** Where a Space's change radar is (CB-282). */
export const spaceRadarPath = (spaceId: string) => `${spacePath(spaceId)}/radar`;

/** Where a Space's people and who sees it are set (CB-181). */
export const spaceSettingsPath = (spaceId: string) => `${spacePath(spaceId)}/settings`;

/** A Space's name as a heading shows it: with its lock when private. */
export function spaceTitle(space: Space) {
    return (
        <span className="inline-flex min-w-0 items-center gap-2">
            <span className="min-w-0 break-words">{space.name}</span>
            {space.private && <PrivateSpaceIcon className="size-4" />}
        </span>
    );
}

/**
 * A Space's views, Pages, Memory, Radar and Settings, as links: each its
 * own address, so the browser's back and a shared link keep the tab.
 */
export function SpaceTabs({ space }: { space: Space }) {
    const { t } = useTranslation(['spaces']);
    const tab = ({ isActive }: { isActive: boolean }) =>
        cn(
            'inline-flex min-h-9 items-center rounded-md px-3 text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
            isActive && 'bg-accent font-medium text-foreground',
        );
    return (
        <nav
            aria-label={t('spaces:tabs.label', { space: space.name })}
            data-slot="space-tabs"
            className="flex flex-wrap gap-1 px-4 md:px-6"
        >
            {/* Each tab's route has its own loader (its words): fetched on intent. */}
            <NavLink end to={spacePath(space.id)} prefetch="intent" className={tab}>
                {t('spaces:tabs.pages')}
            </NavLink>
            <NavLink to={spaceMemoryPath(space.id)} prefetch="intent" className={tab}>
                {t('spaces:tabs.memory')}
            </NavLink>
            <NavLink to={spaceRadarPath(space.id)} prefetch="intent" className={tab}>
                {t('spaces:tabs.radar')}
            </NavLink>
            <NavLink to={spaceSettingsPath(space.id)} prefetch="intent" className={tab}>
                {t('spaces:tabs.settings')}
            </NavLink>
        </nav>
    );
}
