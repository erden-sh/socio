import { useEffect, useState } from 'react';

import { dateTimeFormat } from '@socio/shared/locale';
import type { PersonReleases as Seen } from '@socio/shared/updates/release-seen';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

const when = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const firstSeen = (value: number) => when.format(value);

/**
 * Admins, on a person's row in People (CB-166): which releases they were
 * shown and when, newest release first, and the newest they opened What's
 * new on. For support: a fix they ask about may be in a release they never
 * saw.
 */
export function PersonReleases({ userId, name }: { userId: string; name: string }) {
    const [seen, setSeen] = useState<Seen>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        const controller = new AbortController();
        api<Seen>(`/admin/people/${encodeURIComponent(userId)}/releases`, 'GET', undefined, controller.signal)
            .then(setSeen)
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load their releases.');
                }
            });
        return () => controller.abort();
    }, [userId]);
    return (
        <section
            data-slot="person-releases"
            aria-label={`Releases ${name} has seen`}
            className="grid gap-1 rounded-md border border-dashed p-2 text-sm"
        >
            {error ? (
                <span className="text-muted-foreground">{error}</span>
            ) : !seen ? (
                <span className="text-muted-foreground">Loading…</span>
            ) : (
                <>
                    <span className="text-muted-foreground">
                        Last opened What’s new at {seen.lastSeen ? `v${seen.lastSeen}` : 'no release yet'}.
                    </span>
                    {seen.views.length ? (
                        <ul className="grid gap-0.5" aria-label="Releases seen">
                            {seen.views.map((view) => (
                                <li key={view.version} className="flex flex-wrap gap-x-2">
                                    <span className="font-medium">v{view.version}</span>
                                    <span className="text-muted-foreground">
                                        first seen <LocalTime value={view.firstSeenAt} format={firstSeen} />
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <span>They haven’t been shown any release yet.</span>
                    )}
                </>
            )}
        </section>
    );
}
