import { Link } from 'react-router';

import {
    DEFAULT_OPS_QUERY,
    OPS_FILTER_LABELS,
    OPS_FILTERS,
    opsSearch,
    type OpsFilters,
} from '@socio/shared/operations/operations';
import {
    ACCESS_CONTEXT_LABELS,
    ACCESS_NAMED_FILTERS,
    ACCESS_SURFACE_LABELS,
    type AccessNamedFilter,
    type OpsAccessRow,
} from '@socio/shared/operations/operations-access';

import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';

import { formatWhen } from './format';
import { OPS_GROUPS, opsPath } from './sections';
import { transcriptPath } from './transcript-path';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * A socio, person or Space that is gone, by the start of its id: enough
 * to tell two apart without a line of hex.
 */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** The view an entry is about, as a link to it where there is one. */
function Subject({ row }: { row: OpsAccessRow }) {
    const id = row.subjectId;
    const name = row.subjectName ?? (id && shortId(id));
    const link = 'min-w-0 truncate font-medium hover:underline';
    switch (row.subjectKind) {
        case 'workspace':
            return <span className="font-medium">Every turn</span>;
        case 'chat': {
            // A room (CB-213): a workspace admin reads one only here, logged.
            const room = !!id && row.filters.room === id;
            return (
                <>
                    {row.subjectName === null ? (
                        <span className="text-muted-foreground">{room ? 'A removed room' : 'A deleted chat'}</span>
                    ) : (
                        <Link to={transcriptPath(id!, 'access-log')} className={link}>
                            {name}
                        </Link>
                    )}
                    {room && <Badge variant="secondary">Room</Badge>}
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
export function accessContext({
    filters,
    filterNames,
    subjectId = null,
}: Pick<OpsAccessRow, 'filters' | 'filterNames'> & Partial<Pick<OpsAccessRow, 'subjectId'>>) {
    const via = filters.via;
    const section = OPS_GROUPS.flatMap((group) => group.sections).find((item) => item.id === via);
    const from = via && `from ${section?.label ?? via}`;
    const narrowed = Object.entries(filters)
        .filter(([name, value]) => name !== 'via' && !(name === 'room' && value === subjectId))
        .map(([name, value]) => {
            const label = (OPS_FILTERS as readonly string[]).includes(name)
                ? OPS_FILTER_LABELS[name as keyof typeof OPS_FILTER_LABELS]
                : (ACCESS_CONTEXT_LABELS[name] ?? name);
            const named = (ACCESS_NAMED_FILTERS as readonly string[]).includes(name)
                ? (filterNames[name as AccessNamedFilter] ?? shortId(value))
                : value;
            return `${label.toLowerCase()} ${named}`;
        })
        .join(', ');
    return [from, narrowed].filter(Boolean).join(' · ');
}

/**
 * Operations → Access log (CB-188): each time an admin opened a person’s
 * activity or a chat’s content here, newest first, loading more as the
 * list scrolls. Every admin sees every entry, their own too. The server
 * writes them; nothing here can change one.
 */
export function AccessLogPage() {
    const { timeZone } = useOpsSettings();
    const entries = useCursorList<OpsAccessRow>('/operations/access-log');
    return (
        <Card data-slot="ops-access-log" className="gap-4">
            <CardHeader>
                <CardTitle>Who opened what</CardTitle>
                <CardDescription>
                    Lists of people’s turns are written once per admin and filters every 15 minutes; every chat or turn
                    trace opened is written each time. Entries can’t be edited or removed, and the people whose chats
                    were read aren’t told.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <InfiniteList
                    list={entries}
                    label="Access log"
                    itemKey={(row) => row.id}
                    empty="No one has opened a person’s activity or a chat here yet."
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
                                    {ACCESS_SURFACE_LABELS[row.surface] ?? row.surface}
                                </span>
                                <Subject row={row} />
                                {row.content && <Badge variant="outline">Content</Badge>}
                                <span
                                    className="ml-auto text-xs text-muted-foreground tabular-nums"
                                    title={`Request ${row.requestId}`}
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
