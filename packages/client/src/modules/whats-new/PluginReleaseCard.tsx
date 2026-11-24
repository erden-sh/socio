import { ChevronDown, Puzzle } from 'lucide-react';
import { useId, useState } from 'react';

import { dateTimeFormat } from '@socio/shared/locale';
import type { PluginReleaseNote } from '@socio/shared/updates/whats-new';

import { PluginNotesMarkdown } from './PluginNotesMarkdown';
import { newSince, usePluginReleaseNotes, type PluginCard } from './use-plugin-release-notes';

import { cn } from '@/lib/utils';

// A version's day is the same on the server and in every browser.
const day = dateTimeFormat({ dateStyle: 'medium', timeZone: 'UTC' });
const releaseDay = (date: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? day.format(new Date(`${date}T00:00:00Z`)) : date;

/** One version of a plugin: its number, day, title and notes. */
export function PluginVersion({ release }: { release: PluginReleaseNote }) {
    return (
        <li data-slot="plugin-release" data-version={release.version} className="grid min-w-0 grid-cols-1 gap-1">
            <div className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="font-semibold">v{release.version}</span>
                {release.title && <span className="min-w-0 truncate font-medium">{release.title}</span>}
                <span className="ml-auto shrink-0 text-muted-foreground">{releaseDay(release.date)}</span>
            </div>
            <PluginNotesMarkdown text={release.notes} className="text-xs text-muted-foreground" />
        </li>
    );
}

/**
 * A plugin's card in What's new and on the releases page (CB-527): the
 * versions since the person last looked, then the older ones folded away.
 */
export function PluginReleaseCard({ card, className }: { card: PluginCard; className?: string }) {
    const fresh = newSince(card);
    const older = card.releases.slice(fresh.length);
    const [open, setOpen] = useState(false);
    const olderId = useId();
    return (
        <article
            data-slot="plugin-release-card"
            data-plugin={card.id}
            aria-label={`${card.name} v${card.version}`}
            className={cn(
                'grid min-w-0 grid-cols-1 gap-2 rounded-xl border bg-card p-3 text-card-foreground shadow-xs',
                className,
            )}
        >
            <div className="flex min-w-0 items-center gap-2">
                <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <h3 className="min-w-0 truncate text-sm font-semibold">{card.name}</h3>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">v{card.version}</span>
            </div>
            {fresh.length > 0 && (
                <ul data-slot="plugin-release-new" className="grid grid-cols-1 gap-3">
                    {fresh.map((release) => (
                        <PluginVersion key={release.version} release={release} />
                    ))}
                </ul>
            )}
            {older.length > 0 && (
                <div className="grid grid-cols-1 gap-2">
                    <button
                        type="button"
                        data-slot="plugin-release-older"
                        aria-expanded={open}
                        aria-controls={olderId}
                        onClick={() => setOpen(!open)}
                        className="inline-flex items-center gap-1 justify-self-start rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
                        {fresh.length ? 'Earlier versions' : 'Versions'} ({older.length})
                    </button>
                    {open && (
                        <ul id={olderId} className="grid grid-cols-1 gap-3">
                            {older.map((release) => (
                                <PluginVersion key={release.version} release={release} />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </article>
    );
}

/** Every plugin's card the person may see, or nothing. */
export function PluginReleaseCards({ className }: { className?: string }) {
    const { plugins } = usePluginReleaseNotes();
    if (!plugins.length) {
        return null;
    }
    return (
        <section
            data-slot="plugin-release-cards"
            aria-label="Plugins"
            className={cn('grid grid-cols-1 gap-2', className)}
        >
            {plugins.map((card) => (
                <PluginReleaseCard key={card.id} card={card} />
            ))}
        </section>
    );
}
