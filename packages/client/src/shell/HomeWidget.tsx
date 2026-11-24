import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { Tone } from '../modules/types';

import { toneTile } from './tones';

import { cn } from '@/lib/utils';

/**
 * A home launcher widget (a `home.widgets` contribution): one row of the
 * At a glance card (CB-308), with an identity tile, a title, a headline
 * value and a line of detail; a link when `to` is set, with an optional
 * action button beside it. `actionable` marks the value as something
 * waiting for the person: the only line in the card in the accent color.
 */
export function HomeWidget({
    icon: Icon,
    tone,
    title,
    value,
    children,
    to,
    action,
    actionable,
}: {
    icon: LucideIcon;
    tone: Tone;
    title: string;
    value: ReactNode;
    children?: ReactNode;
    to?: string;
    action?: ReactNode;
    actionable?: boolean;
}) {
    const body = (
        <>
            <span
                aria-hidden
                className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', toneTile[tone])}
            >
                <Icon className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
                <span className="text-[13px] text-muted-foreground">{title}</span>
                <span
                    data-slot="home-widget-value"
                    className={cn('truncate text-[15px] font-medium tabular-nums', actionable && 'text-primary')}
                >
                    {value}
                </span>
                {children && (
                    <span className="truncate text-[13px] text-muted-foreground tabular-nums">{children}</span>
                )}
            </span>
        </>
    );
    const frame = 'flex min-w-0 flex-1 items-start gap-3 rounded-lg p-2 text-left outline-none';
    return (
        <section data-slot="home-widget" aria-label={title} className="flex min-w-0 items-center gap-2 p-2">
            {to ? (
                <Link
                    data-slot="home-widget-link"
                    to={to}
                    className={cn(
                        frame,
                        'transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    )}
                >
                    {body}
                </Link>
            ) : (
                <div data-slot="home-widget-body" className={frame}>
                    {body}
                </div>
            )}
            {action}
        </section>
    );
}
