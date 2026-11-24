import { ChevronDown, Gift } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { dateTimeFormat } from '@socio/shared/locale';
import { RELEASE_TAG, type Release, type ReleaseSummary, type ReleasesResponse } from '@socio/shared/updates/releases';

import { useLoadMoreSentinel } from '../components/infinite-list/use-load-more-sentinel';
import { api, ApiError } from '../lib/api';
import { IssueMarkdown } from '../modules/issues/IssueMarkdown';
import { PluginReleaseCards } from '../modules/whats-new/PluginReleaseCard';
import { UpstreamIssueLink } from '../modules/whats-new/UpstreamIssueLink';
import { useReleaseView } from '../modules/whats-new/use-whats-new';

import { WorkspacePage } from './WorkspacePage';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const LINK = 'underline underline-offset-2 hover:text-primary';

// A release's day, the same on the server and in every browser.
const day = dateTimeFormat({ dateStyle: 'medium', timeZone: 'UTC' });
export const releaseDate = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

/** A release's full notes, asked for when they are first opened. */
function ReleaseNotesBody({ tag }: { tag: string }) {
    const [release, setRelease] = useState<Release>();
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        api<Release>(`/releases/${tag}`)
            .then((found) => !cancelled && setRelease(found))
            .catch(() => !cancelled && setFailed(true));
        return () => {
            cancelled = true;
        };
    }, [tag]);
    if (failed) {
        return (
            <p className="text-sm text-muted-foreground">Couldn’t load these notes. Reload the page to try again.</p>
        );
    }
    if (!release) {
        return <Skeleton className="h-24" />;
    }
    return (
        <IssueMarkdown text={release.notesMarkdown} upstreamIssueKeys className="[&_h3]:mt-5 [&_h3:first-child]:mt-0" />
    );
}

/** A release's card: its version, date, summary, highlights and notes. */
function ReleaseCard({
    release,
    current,
    initiallyOpen,
}: {
    release: ReleaseSummary;
    current: boolean;
    initiallyOpen: boolean;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    // Asked for later (a link to it from this page): open it then too.
    useEffect(() => {
        if (initiallyOpen) {
            setOpen(true);
        }
    }, [initiallyOpen]);
    const notesId = `${release.tag}-notes`;
    // Scrolled into view, it counts as seen (CB-166).
    const seen = useReleaseView(release.version);
    return (
        <Card ref={seen} id={release.tag} data-slot="release-card" data-release={release.tag} className="scroll-mt-4">
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                    <Link to={release.url} className="hover:text-primary">
                        {release.tag}
                    </Link>
                    {current && <Badge variant="secondary">Current</Badge>}
                </CardTitle>
                <CardDescription>{releaseDate(release.date)}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <p className="text-sm leading-relaxed">{release.summary}</p>
                {release.highlights.length > 0 && (
                    <ul aria-label={`${release.tag} highlights`} className="grid list-disc gap-1 pl-5 text-sm">
                        {release.highlights.map((item) => (
                            <li key={`${item.title}-${item.issue ?? ''}`}>
                                {item.title}
                                {item.issue && (
                                    <>
                                        {' '}
                                        <UpstreamIssueLink
                                            className={cn(LINK, 'text-muted-foreground')}
                                            issue={item.issue}
                                        />
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <div className="grid gap-3 border-t pt-3">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="justify-self-start px-2"
                        aria-expanded={open}
                        aria-controls={notesId}
                        onClick={() => setOpen(!open)}
                    >
                        <ChevronDown className={cn('transition-transform', !open && '-rotate-90')} />
                        {open ? 'Hide the full notes' : 'Full notes'}
                    </Button>
                    {open && (
                        <div id={notesId} data-slot="release-notes">
                            <ReleaseNotesBody tag={release.tag} />
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

/** Releases asked for at a time; the next page loads as the end scrolls near. */
export const RELEASES_PAGE = 10;

/** The pages loaded so far: newest first, and where the next one starts. */
interface Listing {
    current: string;
    commit: string | null;
    releases: ReleaseSummary[];
    /** The `before` of the next, older page; null once every release is here. */
    nextCursor: string | null;
}

const pagePath = (cursor?: string) =>
    `/releases?limit=${RELEASES_PAGE}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;

/**
 * Socio's release notes (CB-168): every release, newest first, with its
 * summary and highlights; its full notes open on demand, the newest's (or
 * the asked-for release's, at `/releases/v0.5.0`) open from the start.
 * The list loads a page at a time (`GET /api/releases?limit=&before=`),
 * the next as its end scrolls near, with a Load more button that does the
 * same from the keyboard. An asked-for release further down loads the
 * pages up to it by itself.
 */
export function ReleasesPage({ tag }: { tag?: string }) {
    const [data, setData] = useState<Listing>();
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    // A page on its way: a second loadMore before it lands asks nothing.
    const busy = useRef(false);
    // Mounted: a later page that lands after unmount is dropped.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        // This request's own flag: a replayed effect (StrictMode) or an
        // unmount drops it, so a stale first page never lands over later ones.
        let cancelled = false;
        api<ReleasesResponse>(pagePath())
            .then((found) => {
                if (!cancelled) {
                    setData({
                        current: found.current,
                        commit: found.commit,
                        releases: found.releases,
                        nextCursor: found.nextCursor ?? null,
                    });
                }
            })
            .catch((error: unknown) => {
                if (cancelled) {
                    return;
                }
                toast.error(error instanceof ApiError ? error.message : 'Could not load the release notes.');
            });
        return () => {
            cancelled = true;
            alive.current = false;
        };
    }, []);
    const cursor = data?.nextCursor;
    const loadMore = useCallback(() => {
        if (!cursor || busy.current) {
            return;
        }
        busy.current = true;
        setLoading(true);
        setFailed(false);
        api<ReleasesResponse>(pagePath(cursor))
            .then((page) => {
                if (!alive.current) {
                    return;
                }
                setData((now) => {
                    if (!now) {
                        return now;
                    }
                    const known = new Set(now.releases.map((release) => release.tag));
                    return {
                        ...now,
                        releases: [...now.releases, ...page.releases.filter((release) => !known.has(release.tag))],
                        nextCursor: page.nextCursor ?? null,
                    };
                });
            })
            .catch(() => alive.current && setFailed(true))
            .finally(() => {
                busy.current = false;
                if (alive.current) {
                    setLoading(false);
                }
            });
    }, [cursor]);
    const hasMore = !!cursor;
    const sentinel = useLoadMoreSentinel(hasMore && !loading && !failed, loadMore);
    const asked = tag && data?.releases.find((item) => item.tag === tag);
    // An asked-for release not loaded yet, with pages left that may hold it.
    const pending = !!tag && !!data && !asked && hasMore && RELEASE_TAG.test(tag);
    // The pages up to it load by themselves, unless one failed (Try again).
    const seeking = pending && !failed;
    useEffect(() => {
        if (seeking && !loading) {
            loadMore();
        }
    }, [seeking, loading, loadMore]);
    // Opens at the asked-for release once the list is there.
    useEffect(() => {
        if (asked) {
            document.getElementById(asked.tag)?.scrollIntoView?.({ block: 'start' });
        }
    }, [asked]);
    // The newest stays closed while the asked-for release may still come,
    // even after a failed page.
    const openTag = asked ? asked.tag : pending ? undefined : data?.releases[0]?.tag;
    return (
        <WorkspacePage
            slot="releases-page"
            icon={Gift}
            tone="mint"
            measure="reading"
            title="Release notes"
            description={
                data
                    ? `You’re on v${data.current}${data.commit ? ` (${data.commit})` : ''}. Every release, newest first.`
                    : 'Every release, newest first.'
            }
        >
            {/* CB-527: the installed plugins' notes, a card each, for the plugins the person may open. */}
            <PluginReleaseCards className="mb-4" />
            <div className="grid gap-4" aria-busy={!data || loading}>
                {tag && data && !asked && !pending && (
                    <p role="status" className="text-sm text-muted-foreground">
                        {RELEASE_TAG.test(tag) ? `There is no release ${tag}.` : `“${tag}” isn’t a release.`}{' '}
                        <Link className={LINK} to="/releases">
                            All releases
                        </Link>
                    </p>
                )}
                {!data ? (
                    <>
                        <Skeleton className="h-48" />
                        <Skeleton className="h-48" />
                    </>
                ) : !data.releases.length ? (
                    <p className="text-sm text-muted-foreground">No releases yet: this build has no release notes.</p>
                ) : (
                    data.releases.map((release) => (
                        <ReleaseCard
                            key={release.tag}
                            release={release}
                            current={release.version === data.current}
                            initiallyOpen={release.tag === openTag}
                        />
                    ))
                )}
                {loading && <Skeleton className="h-48" />}
                {failed && !loading && (
                    <div
                        role="alert"
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                    >
                        <span>Couldn’t load older releases.</span>
                        <Button variant="outline" size="sm" onClick={loadMore}>
                            Try again
                        </Button>
                    </div>
                )}
                {hasMore && !loading && !failed && (
                    <>
                        <div ref={sentinel} data-slot="releases-end" className="h-px" />
                        <div>
                            <Button variant="outline" size="sm" onClick={loadMore}>
                                Load more
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </WorkspacePage>
    );
}
