import { AppWindow, Bug, ExternalLink } from 'lucide-react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { DotAppEntry, DotAppsState } from '@socio/shared/apps/app-types';
import { MODULE_IDS } from '@socio/shared/modules';
import type { Dot } from '@socio/shared/types';

import { useInlinedOrOnDemand } from '../../i18n/on-demand';
import { LocalTime } from '../../lib/local-time';
import { useDotPanelData } from '../../shell/DotPanel';
import { SectionTitle } from '../../shell/Home';
import { toneTile } from '../../shell/tones';
import { relative } from '../activity/TaskPresentation';
import { useModuleContext, useModules } from '../context';
import { canUse } from '../derive';
import { openReport } from '../issues/report';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Published, in development or unpublished, as the home page says it (`apps.dot:stage.<id>`). */
const STAGE = {
    promoted: { id: 'published', variant: 'secondary' },
    ephemeral: { id: 'development', variant: 'outline' },
    packaged: { id: 'development', variant: 'outline' },
    unpublished: { id: 'unpublished', variant: 'outline' },
} as const;

const cardClass =
    'flex h-full min-w-0 items-start gap-3 rounded-xl border bg-card p-3 text-sm text-card-foreground shadow-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * A socio's home page, Apps (CB-260): the apps it built that the
 * signed-in person may open (their own, and those shared with their
 * Spaces), published or in development. Nothing here starts an app: a
 * row opens it through the launch hand-off in a new tab, where a stopped
 * one says so; an unpublished one goes to the Apps page, where its owner
 * publishes it. Shown only to people who may use Apps, and only where
 * mini apps are set up. Its words load on demand (apps.dot), with its
 * data: nothing until both.
 */
export function DotApps({ dot }: { dot: Dot }) {
    const module = useModules().find((item) => item.id === MODULE_IDS.apps);
    const context = useModuleContext();
    if (!module || !canUse(module, context)) {
        return null;
    }
    return <DotAppsSection dot={dot} />;
}

function DotAppsSection({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<DotAppsState>(`/apps/dots/${encodeURIComponent(dot.id)}`, 'apps');
    const worded = useInlinedOrOnDemand(['apps.dot']);
    const { t } = useTranslation(['apps.dot']);
    if (!worded || (data && !data.enabled)) {
        return null;
    }
    return (
        <section aria-labelledby="dot-apps" data-slot="dot-apps" className="grid grid-cols-1">
            <div className="flex min-w-0 items-start justify-between gap-2">
                <SectionTitle id="dot-apps">{t('apps.dot:title')}</SectionTitle>
                <Button asChild variant="ghost" size="xs" className="-mt-1 font-normal text-muted-foreground">
                    <Link to="/apps">{t('apps.dot:all')}</Link>
                </Button>
            </div>
            {!data && !failed ? (
                <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3" aria-hidden>
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-20 rounded-xl" />
                </div>
            ) : !data?.apps.length ? (
                <p
                    data-slot="dot-apps-empty"
                    className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
                >
                    {failed
                        ? t('apps.dot:failed')
                        : dot.archivedAt
                          ? t('apps.dot:empty-archived', { name: dot.name })
                          : t('apps.dot:empty', { name: dot.name })}
                </p>
            ) : (
                <ul data-slot="dot-apps-list" className="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
                    {data.apps.map((app) => (
                        <AppItem key={app.id} app={app} />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** What the row says under the name: version, sharing, owner, when. */
function useDetails() {
    const { t } = useTranslation(['apps.dot']);
    return (app: DotAppEntry) =>
        [
            app.status === 'promoted' && app.liveVersion ? t('apps.dot:version', { version: app.liveVersion }) : null,
            app.owner
                ? app.sharedSpaceName
                    ? t('apps.dot:shared-with', { space: app.sharedSpaceName })
                    : t('apps.dot:only-you')
                : app.ownerName
                  ? t('apps.dot:shared-by', { name: app.ownerName })
                  : t('apps.dot:shared-by-other'),
        ].filter(Boolean);
}

/**
 * One app: its name, stage, description and details. A link to open it
 * (a new tab), or to the Apps page while it is unpublished. "Report issue"
 * beside it files one about the app (CB-442).
 */
function AppItem({ app }: { app: DotAppEntry }) {
    const { t } = useTranslation(['apps.dot']);
    const details = useDetails();
    const stage = STAGE[app.status];
    const unpublished = app.status === 'unpublished';
    const body = (
        <>
            <span
                aria-hidden
                className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', toneTile.violet)}
            >
                <AppWindow className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1 grid-cols-1 gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate font-medium">{app.name}</span>
                    <Badge variant={stage.variant} className="py-0 leading-5" data-slot="dot-app-stage">
                        {t(`apps.dot:stage.${stage.id}`)}
                    </Badge>
                    {!unpublished && (
                        <ExternalLink aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                    )}
                </span>
                {app.description && (
                    <span className="line-clamp-2 text-muted-foreground break-words">{app.description}</span>
                )}
                <span className="truncate pr-6 text-xs text-muted-foreground">
                    {[...details(app), ''].join(' · ')}
                    <LocalTime value={app.updatedAt} format={relative} />
                </span>
            </span>
        </>
    );
    return (
        <li data-slot="dot-app" data-status={app.status} className="relative min-w-0">
            {unpublished ? (
                <Link to="/apps" className={cardClass}>
                    {body}
                    <span className="sr-only"> {t('apps.dot:manage-hint')}</span>
                </Link>
            ) : (
                <a
                    href={`/apps/${encodeURIComponent(app.id)}/open`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cardClass}
                >
                    {body}
                    <span className="sr-only"> {t('apps.dot:new-tab-hint')}</span>
                </a>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="absolute right-1.5 bottom-1.5 size-7 text-muted-foreground"
                aria-label={t('apps.dot:report-label', { name: app.name })}
                title={t('apps.dot:report')}
                data-slot="dot-app-report-issue"
                onClick={(event) => openReport({ components: [`app:${app.id}`] }, { returnFocus: event.currentTarget })}
            >
                <Bug className="size-3.5" />
            </Button>
        </li>
    );
}
