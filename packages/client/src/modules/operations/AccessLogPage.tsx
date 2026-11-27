import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { DEFAULT_OPS_QUERY, OPS_FILTERS, opsSearch, type OpsFilters } from '@socio/shared/operations/operations';
import {
    ACCESS_LOG_DEDUPE_MS,
    ACCESS_NAMED_FILTERS,
    type AccessNamedFilter,
    type OpsAccessRow,
} from '@socio/shared/operations/operations-access';

import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import { formatWhen } from './format';
import { OPS_SECTIONS, opsPath, type OpsSectionId } from './sections';
import { transcriptPath } from './transcript-path';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * A socio, person or Space that is gone, by the start of its id: enough
 * to tell two apart without a line of hex.
 */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/**
 * Where a view was opened (`ACCESS_SURFACE_LABELS`' ids), named by the
 * `surfaces.<id>` keys; the log shows an unknown one as it is stored.
 */
const SURFACES = [
    'turns',
    'chat',
    'trace',
    'activity',
    'value',
    'activity-people',
    'activity-socios',
    'activity-chats',
    'value-sessions',
    'failures',
    'failure-label',
    'health',
    'health-schedules',
    'health-long-runs',
    'knowledge-datasets',
    'chat-grounding',
    'cost',
    'themes',
    'session-labels',
    'session-label',
    'room-events',
] as const;
const isSurface = (surface: string): surface is (typeof SURFACES)[number] =>
    (SURFACES as readonly string[]).includes(surface);

/** What the log names a filter by: Operations' own, and a room's context (`ACCESS_ROOM_CONTEXT`). */
const NAMED_CONTEXTS = [...OPS_FILTERS, 'room', 'initiator'] as const;
const isNamedContext = (name: string): name is (typeof NAMED_CONTEXTS)[number] =>
    (NAMED_CONTEXTS as readonly string[]).includes(name);

/** The view an entry is about, as a link to it where there is one. */
function Subject({ row }: { row: OpsAccessRow }) {
    const { t } = useTranslation(['operations.access-log']);
    const id = row.subjectId;
    const name = row.subjectName ?? (id && shortId(id));
    const link = 'min-w-0 truncate font-medium hover:underline';
    switch (row.subjectKind) {
        case 'workspace':
            return <span className="font-medium">{t('operations.access-log:subject.workspace')}</span>;
        case 'chat': {
            // A room (CB-213): a workspace admin reads one only here, logged.
            const room = !!id && row.filters.room === id;
            return (
                <>
                    {row.subjectName === null ? (
                        <span className="text-muted-foreground">
                            {room
                                ? t('operations.access-log:subject.removed-room')
                                : t('operations.access-log:subject.deleted-chat')}
                        </span>
                    ) : (
                        <Link to={transcriptPath(id!, 'access-log')} className={link}>
                            {name}
                        </Link>
                    )}
                    {room && <Badge variant="secondary">{t('operations.access-log:subject.room')}</Badge>}
                </>
            );
        }
        case 'person':
        case 'socio':
        case 'space': {
            const filters: OpsFilters = { [row.subjectKind]: id! };
            return (
                <Link to={opsPath('overview', opsSearch({ ...DEFAULT_OPS_QUERY, filters }))} className={link}>
                    {name}
                </Link>
            );
        }
        default:
            return <span className="font-medium">{name}</span>;
    }
}

/**
 * “from Overview · socio Manny, range 30d”: where it was opened, and how
 * narrowed. A socio, person or Space shows by its name, or a short id
 * once it is gone. A room's turn trace says its room, who started it and
 * the socio that ran it (CB-213): “room Launch, started by Ada, socio
 * Manny”; a room's own views say the room by their subject instead.
 */
export function useAccessContext() {
    const { t } = useTranslation(['operations.access-log', 'operations']);
    return ({
        filters,
        filterNames,
        subjectId = null,
    }: Pick<OpsAccessRow, 'filters' | 'filterNames'> & Partial<Pick<OpsAccessRow, 'subjectId'>>) => {
        const via = filters.via;
        const from =
            via &&
            t('operations.access-log:context.from', {
                section: (OPS_SECTIONS as readonly string[]).includes(via)
                    ? t(`operations:sections.${via as OpsSectionId}.label`)
                    : via,
            });
        const narrowed = Object.entries(filters)
            .filter(([name, value]) => name !== 'via' && !(name === 'room' && value === subjectId))
            .map(([name, value]) => {
                const named = (ACCESS_NAMED_FILTERS as readonly string[]).includes(name)
                    ? (filterNames[name as AccessNamedFilter] ?? shortId(value))
                    : value;
                return isNamedContext(name)
                    ? t('operations.access-log:context.filter', { context: name, value: named })
                    : t('operations.access-log:context.other', { name, value: named });
            })
            .join(', ');
        return [from, narrowed].filter(Boolean).join(' · ');
    };
}

/**
 * Operations → Access log (CB-188): each time an admin opened a person’s
 * activity or a chat’s content here, newest first, loading more as the
 * list scrolls. Every admin sees every entry, their own too. The server
 * writes them; nothing here can change one.
 */
export function AccessLogPage() {
    const { t } = useTranslation(['operations.access-log', 'operations']);
    const accessContext = useAccessContext();
    const { timeZone } = useOpsSettings();
    const entries = useCursorList<OpsAccessRow>('/operations/access-log');
    return (
        <Card data-slot="ops-access-log" className="gap-4">
            <CardHeader>
                <CardTitle>{t('operations.access-log:title')}</CardTitle>
                <CardDescription>
                    {t('operations.access-log:description', { minutes: ACCESS_LOG_DEDUPE_MS / 60_000 })}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={entries}
                    label={t('operations:sections.access-log.label')}
                    itemKey={(row) => row.id}
                    empty={t('operations.access-log:empty')}
                    renderItem={(row) => {
                        const where = accessContext(row);
                        return (
                            <div
                                data-slot="ops-access-entry"
                                data-subject={row.subjectKind}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <span className="font-medium">{row.viewerName ?? row.viewerId}</span>
                                <span className="text-muted-foreground">
                                    {isSurface(row.surface)
                                        ? t(`operations.access-log:surfaces.${row.surface}`)
                                        : row.surface}
                                </span>
                                <Subject row={row} />
                                {row.content && <Badge variant="outline">{t('operations.access-log:content')}</Badge>}
                                <span
                                    className="ml-auto text-xs text-muted-foreground tabular-nums"
                                    title={t('operations.access-log:request', { id: row.requestId })}
                                >
                                    {where && `${where} · `}
                                    {formatWhen(row.at, timeZone)}
                                </span>
                            </div>
                        );
                    }}
                />
            </CardContent>
        </Card>
    );
}
