/**
 * App-store cards adapted from calcom/cal.diy (MIT), apps/web/modules/apps
 * and packages/app-store: category tiles, app cards, and an app detail.
 * Copyright (c) Cal.com, Inc.
 *
 * Empty states borrow the spacing and type of satnaing/shadcn-admin (MIT).
 * Copyright (c) Sat Naing.
 *
 * Install, enable, and scale stay with the page that owns the catalog API.
 */
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, Puzzle } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CategoryCard({
    name,
    detail,
    icon: Icon,
    className,
    selected,
    onClick,
}: {
    name: string;
    detail: string;
    icon: LucideIcon;
    className?: string;
    selected?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'relative flex h-36 flex-col justify-end overflow-hidden rounded-2xl bg-linear-to-br p-4 text-left text-white shadow-sm ring-offset-background',
                className,
                selected && 'ring-2 ring-ring ring-offset-2',
            )}
        >
            <Icon className="absolute top-4 right-4 size-8 opacity-70" aria-hidden />
            <span className="text-lg font-semibold">{name}</span>
            <span className="text-sm text-white/80">{detail}</span>
        </button>
    );
}

export function AppCard({
    name,
    author,
    version,
    description,
    installed,
    icon,
    onOpen,
}: {
    name: string;
    author: string;
    version: string;
    description: string;
    installed: boolean;
    icon: ReactNode;
    onOpen: () => void;
}) {
    return (
        <article
            data-slot="plugin-catalog-card"
            className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        >
            <div className="flex items-start gap-3">
                {icon}
                <div className="min-w-0">
                    <h3 className="font-medium">{name}</h3>
                    <p className="text-xs text-muted-foreground">
                        {author} · {version}
                    </p>
                </div>
            </div>
            <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">{description}</p>
            <div className="flex items-center justify-between gap-2">
                <Badge variant={installed ? 'default' : 'secondary'}>{installed ? 'Installed' : 'Not installed'}</Badge>
                <Button type="button" variant="outline" size="sm" onClick={onOpen}>
                    Details
                </Button>
            </div>
        </article>
    );
}

export function AppDetail({
    icon,
    name,
    meta,
    description,
    installed,
    onBack,
    onInstall,
    onManage,
    screenshots,
    permissions,
    status,
}: {
    icon: ReactNode;
    name: string;
    meta: string;
    description: string;
    installed: boolean;
    onBack: () => void;
    onInstall: () => void;
    onManage: () => void;
    screenshots?: ReactNode;
    permissions?: ReactNode;
    status?: ReactNode;
}) {
    return (
        <article className="grid gap-6">
            <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={onBack}>
                <ArrowLeft /> Back to the store
            </Button>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                    {icon}
                    <div>
                        <h2 className="text-xl font-semibold tracking-tight">{name}</h2>
                        <p className="text-sm text-muted-foreground">{meta}</p>
                        <p className="mt-2 max-w-xl text-sm">{description}</p>
                    </div>
                </div>
                {installed ? (
                    <Button type="button" onClick={onManage}>
                        Manage
                    </Button>
                ) : (
                    <Button type="button" onClick={onInstall}>
                        Install
                    </Button>
                )}
            </div>
            {screenshots && (
                <section className="grid gap-3">
                    <h3 className="text-sm font-medium">Screenshots</h3>
                    {screenshots}
                </section>
            )}
            {permissions && (
                <section className="grid gap-2">
                    <h3 className="text-sm font-medium">Permissions</h3>
                    {permissions}
                    {status}
                </section>
            )}
        </article>
    );
}

export function ScreenshotFrame({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
    return (
        <figure className="overflow-hidden rounded-xl border bg-muted">
            <div className="bg-linear-to-br from-muted to-accent p-3">{children}</div>
            <figcaption className="px-3 py-2">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{caption}</p>
            </figcaption>
        </figure>
    );
}

export function InstalledCard({
    icon,
    name,
    badges,
    description,
    meta,
    permissions,
    children,
}: {
    icon: ReactNode;
    name: string;
    badges?: ReactNode;
    description: string;
    meta: string;
    permissions?: string;
    children?: ReactNode;
}) {
    return (
        <article
            data-slot="plugin-card"
            className="grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
        >
            <div className="flex items-start gap-3">
                {icon}
                <div className="min-w-0 flex-1">
                    <h3 className="flex flex-wrap items-center gap-2 font-medium">
                        {name}
                        {badges}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
                </div>
            </div>
            {permissions && <p className="text-sm text-muted-foreground">{permissions}</p>}
            {children}
        </article>
    );
}

export function CatalogEmpty({ title, body, icon: Icon = Puzzle }: { title: string; body: string; icon?: LucideIcon }) {
    return (
        <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <Icon className="size-5" aria-hidden />
            </div>
            <p className="text-base font-semibold">{title}</p>
            <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        </div>
    );
}
