import { Link } from 'react-router';

import { earlyAccessForIssue } from '@socio/shared/flags';
import { dateTimeFormat } from '@socio/shared/locale';
import type { ReleaseSummary } from '@socio/shared/updates/releases';
import { UPSTREAM_ISSUE_KEY } from '@socio/shared/updates/upstream';

import { LocalTime } from '../../lib/local-time';
import { EarlyAccessBadge } from '../../shell/flags';

import { UpstreamIssueLink } from './UpstreamIssueLink';
import { useReleaseView } from './use-whats-new';

import { cn } from '@/lib/utils';

/** Highlights a card shows; the release's page has the rest. */
export const CARD_HIGHLIGHTS = 3;

// A release's day is the same everywhere: it is read and shown in UTC.
const day = dateTimeFormat({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
});
const releaseDay = (value: number) => day.format(value);
const dayValue = (date: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};

/**
 * One release as a card (What's new on Home and in the header, and the
 * releases page): its version and day, its summary and its first
 * highlights, each with its board issue. The whole card opens the
 * release's page; the issue keys open their issues on Socio's own board
 * (CB-381). Shown long enough, it
 * counts as seen (`useReleaseView`).
 */
export function ReleaseCard({
    release,
    className,
    onOpen,
}: {
    release: ReleaseSummary;
    className?: string;
    /** Called when one of its links is followed (the header closes its list). */
    onOpen?: () => void;
}) {
    const seen = useReleaseView(release.version);
    const when = dayValue(release.date);
    const highlights = release.highlights.slice(0, CARD_HIGHLIGHTS);
    return (
        <article
            ref={seen}
            data-slot="release-card"
            data-version={release.version}
            aria-label={`Version ${release.version}`}
            className={cn(
                'relative grid min-w-0 grid-cols-1 gap-1.5 rounded-xl border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:border-ring/40 hover:bg-accent/40 has-[[data-slot=release-link]:focus-visible]:ring-[3px] has-[[data-slot=release-link]:focus-visible]:ring-ring/50',
                className,
            )}
        >
            <div className="flex min-w-0 items-baseline gap-2">
                <Link
                    data-slot="release-link"
                    to={release.url}
                    onClick={onOpen}
                    className="truncate text-sm font-semibold outline-none after:absolute after:inset-0 after:rounded-[inherit]"
                >
                    v{release.version}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {when === undefined ? release.date : <LocalTime value={when} format={releaseDay} />}
                </span>
            </div>
            {release.summary && (
                <p data-slot="release-summary" className="line-clamp-3 text-sm break-words text-muted-foreground">
                    {release.summary}
                </p>
            )}
            {highlights.length > 0 && (
                <ul data-slot="release-highlights" className="grid grid-cols-1 gap-1 text-xs">
                    {highlights.map((highlight, index) => (
                        <li
                            key={index}
                            className="flex min-w-0 items-baseline gap-1.5 before:size-1 before:shrink-0 before:translate-y-[-1px] before:rounded-full before:bg-muted-foreground/60 before:content-['']"
                        >
                            <span className="min-w-0 flex-1 break-words">
                                {highlight.title}
                                {/* A feature still behind an early-access flag (CB-169). */}
                                {highlight.issue && earlyAccessForIssue(highlight.issue).length > 0 && (
                                    <EarlyAccessBadge className="ml-1.5 align-middle" />
                                )}
                            </span>
                            {highlight.issue && UPSTREAM_ISSUE_KEY.test(highlight.issue) && (
                                <UpstreamIssueLink
                                    slot="release-issue"
                                    issue={highlight.issue}
                                    onClick={onOpen}
                                    className="relative z-10 shrink-0 rounded font-mono text-[11px] text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
}
