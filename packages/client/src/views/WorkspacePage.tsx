import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { NavLink } from 'react-router';

import { useModules } from '../modules/context';
import type { ModuleId, Tone } from '../modules/types';
import { toneTile } from '../shell/tones';

import { cn } from '@/lib/utils';

/**
 * A workspace page's header, as the Issues board has it (CB-220): the
 * module's tile, the title with a line under it, and the page's actions at
 * the right, across the page's whole width. The page chrome's `--page-top`
 * is above it. A toolbar may follow it closely (Issues, a Space's
 * library); WorkspacePage starts its content `--page-gap` below it.
 * `module` takes the tile from the module's manifest; `icon` and `tone`
 * set it for a page outside a module.
 */
export function PageHeader({
    module,
    icon,
    tone = 'slate',
    title,
    children,
    actions,
    titleSlot = 'page-header-title',
    subtitleSlot = 'page-header-subtitle',
}: {
    module?: ModuleId;
    icon?: ComponentType<{ className?: string }>;
    tone?: Tone;
    title: ReactNode;
    /** The line under the title. Kept to a readable width. */
    children?: ReactNode;
    actions?: ReactNode;
    titleSlot?: string;
    subtitleSlot?: string;
}) {
    const manifest = useModules().find((item) => item.id === module);
    const Icon = icon ?? manifest?.icon;
    const tile = manifest && !icon ? manifest.tone : tone;
    return (
        <div data-page-heading className="flex flex-wrap items-center gap-3 px-4 pt-(--page-top) pb-3 md:px-6">
            {Icon && (
                <span
                    aria-hidden
                    className={cn(
                        // Beside the title when the line under it wraps (a phone).
                        'flex size-10 shrink-0 items-center justify-center rounded-lg max-md:self-start',
                        toneTile[tile],
                    )}
                >
                    <Icon className="size-5" />
                </span>
            )}
            <div className="mr-auto grid min-w-0 flex-1 basis-56 gap-0.5">
                <h1
                    data-slot={titleSlot}
                    className="text-2xl font-medium tracking-tight break-words md:text-[1.75rem] md:leading-9"
                >
                    {title}
                </h1>
                {children && (
                    <p data-slot={subtitleSlot} className="max-w-3xl text-sm text-muted-foreground tabular-nums">
                        {children}
                    </p>
                )}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}

/**
 * How wide a page's content runs. `full` uses the page's width (lists,
 * tables, dashboards); `form` stops at a width where settings cards still
 * read well; `reading` keeps long text at a comfortable line length.
 * Both start at the page's left edge, under the header.
 */
export type PageMeasure = 'full' | 'form' | 'reading';
const MEASURE: Record<PageMeasure, string> = {
    full: '',
    form: 'max-w-6xl',
    reading: 'max-w-4xl',
};

/**
 * A workspace page (CB-220): the Issues page's frame for every page that
 * is a list, a table, a dashboard or a form. The header runs the page's
 * width and the content starts at the same left edge, with no centered
 * column. Props other than these go to the `<main>` (Media's drop target).
 */
export function WorkspacePage({
    slot,
    module,
    icon,
    tone,
    title,
    description,
    actions,
    measure = 'full',
    bodyClassName,
    className,
    children,
    ...main
}: Omit<ComponentProps<'main'>, 'title'> & {
    /** The `<main>`'s data-slot. */
    slot?: string;
    module?: ModuleId;
    icon?: ComponentType<{ className?: string }>;
    tone?: Tone;
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    measure?: PageMeasure;
    bodyClassName?: string;
}) {
    return (
        <main data-slot={slot} className={cn('w-full', className)} {...main}>
            <PageHeader module={module} icon={icon} tone={tone} title={title} actions={actions}>
                {description}
            </PageHeader>
            <div
                data-page-body
                className={cn(
                    // With the header's pb-3, the page chrome's gap.
                    'min-w-0 px-4 pt-[calc(var(--page-gap)-0.75rem)] pb-8 md:px-6',
                    MEASURE[measure],
                    bodyClassName,
                )}
            >
                {children}
            </div>
        </main>
    );
}

export interface SectionNavGroup {
    label: string;
    items: { id: string; label: string; to: string; end?: boolean }[];
}

/**
 * A page's section nav (Settings, Operations): a rail at the page's left
 * edge on wide screens, with each group's name, that stays in view while
 * the section scrolls; on narrower screens the entries wrap in rows above
 * the section, so all of them show and nothing scrolls sideways.
 */
export function SectionNav({ label, slot, groups }: { label: string; slot: string; groups: SectionNavGroup[] }) {
    return (
        <nav
            aria-label={label}
            data-slot={slot}
            className="flex min-w-0 flex-wrap gap-1 lg:sticky lg:top-4 lg:grid lg:content-start lg:gap-5 lg:self-start"
        >
            {groups.map((group) => (
                <div key={group.label} className="contents lg:grid lg:gap-1">
                    <span className="hidden px-2 pb-1 text-xs text-muted-foreground lg:block">{group.label}</span>
                    {group.items.map((item) => (
                        <NavLink
                            key={item.id}
                            to={item.to}
                            end={item.end ?? true}
                            className={({ isActive }) =>
                                cn(
                                    'flex h-8 shrink-0 items-center rounded-md px-2 text-sm whitespace-nowrap text-foreground/80 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
                                    isActive && 'bg-accent font-medium text-accent-foreground',
                                )
                            }
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </div>
            ))}
        </nav>
    );
}

/**
 * A page with a section nav (Settings, Operations), in the Issues page's
 * frame: the header across the page, then the nav's rail and the section
 * beside it, the section using the rest of the width (up to the measure).
 */
export function SectionLayout({
    nav,
    children,
    after,
    measure = 'full',
    ...page
}: Omit<ComponentProps<typeof WorkspacePage>, 'bodyClassName'> & {
    nav: ReactNode;
    /** Below the nav and the section (Settings' version line). */
    after?: ReactNode;
}) {
    return (
        <WorkspacePage measure={measure} {...page}>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
                {nav}
                <div className="grid min-w-0 grid-cols-1 content-start gap-6">{children}</div>
            </div>
            {after}
        </WorkspacePage>
    );
}
