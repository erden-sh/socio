import type { FlatNamespace } from 'i18next';
import { Monitor, MoreHorizontal, Pause, Play, Search } from 'lucide-react';
import { Fragment } from 'react';
import { Link, useMatches } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { ModuleId } from '@socio/shared/modules';
import type { Dot } from '@socio/shared/types';

import { ROUTE_NAMESPACES } from '../i18n/page-i18n';
import { useBrandingDocument } from '../lib/branding-meta';
import { Slot, useModuleContext, useModules } from '../modules/context';
import { moduleTitle } from '../modules/derive';

import { ConnectionBadge } from './ConnectionBadge';
import { useCurrentCrumbTitle } from './crumb-title';
import { HeaderMenuItem, HeaderMenuPageSection } from './header-menu';
import { HelpMenu } from './HelpMenu';
import { usePageModuleId, useRouteParams, useShell, type Crumb, type RouteHandle } from './shell-context';

import { SidebarToggle } from '@/components/app-sidebar';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

/** The namespaces in for this page: the root's and its routes' (route-namespaces.json), crumbs' words among them. */
function useCrumbNamespaces(): FlatNamespace[] {
    const ids = useMatches().map((match) => match.id);
    return [...new Set(['root', ...ids].flatMap((id) => ROUTE_NAMESPACES[id] ?? []))] as FlatNamespace[];
}

/**
 * The breadcrumbs of the current route after Home: the deepest route's
 * `handle.crumb`, else its module's title. Empty on the home page.
 */
export function useCrumbs(dot: Dot): {
    crumbs: Crumb[];
    moduleId?: ModuleId;
} {
    // Any namespace a crumb's words are in: the root's, and the route's.
    const { t } = useTranslation(useCrumbNamespaces());
    const { workspace, admin } = useShell();
    const modules = useModules();
    const context = useModuleContext();
    const params = useRouteParams();
    const title = useCurrentCrumbTitle();
    const matches = useMatches();
    const moduleId = usePageModuleId();
    const module = modules.find((item) => item.id === moduleId);
    const match = matches.findLast((item) => (item.handle as RouteHandle | undefined)?.crumb);
    const crumb = (match?.handle as RouteHandle | undefined)?.crumb;
    const crumbs = crumb
        ? crumb({ workspace, admin, dot, params, title, data: match?.loaderData, t })
        : module
          ? [{ label: moduleTitle(module, context) }]
          : [];
    return { crumbs, moduleId };
}

/**
 * The header of every page, inside the sidebar inset: the sidebar toggle,
 * breadcrumbs (Home, then the route's), then Pause for admins as a quiet
 * text button, a divider, and the icon buttons: the modules'
 * `header.actions` contributions (Ask a socio, Report issue), the
 * connection badge (only while it is lost; the account row's dot says
 * all is well), the Help menu (help, What's new, shortcuts, theme) and the
 * computer (CB-308). Pages never draw their own header bar.
 * On phones (below `md`) it is the title, one status indicator (the
 * connection, ConnectionBadge) and a ⋯ menu (HelpMenu's `overflow`) that
 * holds every other control: Search, the `header.menu` slot (Ask a
 * socio, Report issue), Pause, the computer, the page's own menu (the
 * chat's or room's, header-menu.tsx) and the Help menu's items, so the
 * title keeps its room. The hidden controls stay mounted, for their
 * shortcuts and dialogs.
 * While typing, when the keyboard leaves little room, it gives that room
 * to the composer (CB-155).
 */
export function AppHeader({ dot }: { dot: Dot }) {
    const { t } = useTranslation(['shell']);
    const shell = useShell();
    const { admin, state, pane, setPane } = shell;
    const { crumbs, moduleId } = useCrumbs(dot);
    const paused = state.settings.paused;
    const pauseLabel = paused ? t('shell:header.resume') : t('shell:header.pause');
    const togglePause = () => void shell.mutate('/settings', 'PATCH', { paused: !paused });
    // The tab identifies the current page and the app (CB-305): the last
    // crumb is the current page (matching the breadcrumb), Home when there
    // is none. The shell renders this header on every signed-in page.
    const pageTitle = crumbs.at(-1)?.label ?? t('shell:header.home');
    useBrandingDocument(state.settings.branding, pageTitle);
    // Keep separator/gap widths bounded as well as text. Deep page paths
    // retain every destination in a keyboard-accessible menu.
    const collapsed =
        moduleId === 'spaces' && crumbs.length > 2 && crumbs.slice(0, -1).every((item) => item.to && !item.node);
    const visibleCrumbs = collapsed ? crumbs.slice(-2) : crumbs;
    return (
        <header
            data-slot="app-header"
            className="group/header flex h-16 shrink-0 items-center gap-2 px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 keyboard-short:hidden"
        >
            <SidebarToggle className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="flex-nowrap">
                    {collapsed ? (
                        <BreadcrumbItem className="hidden shrink-0 md:inline-flex">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" aria-label={t('shell:header.full-path')}>
                                        <MoreHorizontal aria-hidden />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="start"
                                    collisionPadding={8}
                                    className="max-w-[min(24rem,calc(100vw-1rem))]"
                                >
                                    <DropdownMenuItem asChild>
                                        <Link to="/">{t('shell:header.home')}</Link>
                                    </DropdownMenuItem>
                                    {crumbs.map((item, index) =>
                                        index === crumbs.length - 1 ? (
                                            <DropdownMenuItem key={index} disabled className="[overflow-wrap:anywhere]">
                                                {item.label}
                                            </DropdownMenuItem>
                                        ) : (
                                            <DropdownMenuItem asChild key={index} className="[overflow-wrap:anywhere]">
                                                <Link to={item.to!}>{item.label}</Link>
                                            </DropdownMenuItem>
                                        ),
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </BreadcrumbItem>
                    ) : crumbs.length ? (
                        <BreadcrumbItem className="hidden md:inline-flex">
                            <BreadcrumbLink asChild>
                                <Link to="/">{t('shell:header.home')}</Link>
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                    ) : (
                        <BreadcrumbItem>
                            <BreadcrumbPage>{t('shell:header.home')}</BreadcrumbPage>
                        </BreadcrumbItem>
                    )}
                    {visibleCrumbs.map((item, index) => {
                        const last = index === visibleCrumbs.length - 1;
                        return (
                            <Fragment key={`${index}:${item.label}`}>
                                <BreadcrumbSeparator className="hidden md:block" />
                                <BreadcrumbItem
                                    className={
                                        last ? 'min-w-0 flex-1' : 'hidden min-w-0 max-w-32 shrink-0 md:inline-flex'
                                    }
                                >
                                    {last ? (
                                        (item.node ?? (
                                            <BreadcrumbPage className="truncate">{item.label}</BreadcrumbPage>
                                        ))
                                    ) : item.node ? (
                                        item.node
                                    ) : item.to ? (
                                        <BreadcrumbLink asChild className="max-w-32 truncate">
                                            <Link title={item.label} to={item.to}>
                                                {item.label}
                                            </Link>
                                        </BreadcrumbLink>
                                    ) : (
                                        <span>{item.label}</span>
                                    )}
                                </BreadcrumbItem>
                            </Fragment>
                        );
                    })}
                </BreadcrumbList>
            </Breadcrumb>
            {/* Renaming a chat on a phone: the title box gets the whole bar. */}
            <div className="ml-auto flex shrink-0 items-center gap-1 max-md:group-has-data-[slot=chat-title-input]/header:hidden">
                {/* Phones show the connection and ⋯ (HelpMenu's) alone: the
                    rest stays mounted, for its shortcuts and dialogs, and is
                    reached from ⋯. */}
                {admin && (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground max-md:hidden"
                            aria-label={pauseLabel}
                            title={pauseLabel}
                            onClick={togglePause}
                        >
                            {paused ? <Play /> : <Pause />}
                            <span>{pauseLabel}</span>
                        </Button>
                        <Separator
                            orientation="vertical"
                            data-slot="header-divider"
                            className="mx-1.5 max-md:hidden data-[orientation=vertical]:h-5"
                        />
                    </>
                )}
                <div data-slot="header-actions" className="flex items-center gap-1 max-md:hidden">
                    <Slot name="header.actions" props={{ moduleId }} />
                </div>
                <ConnectionBadge />
                <HelpMenu
                    overflow={
                        <>
                            <HeaderMenuItem open={() => shell.setPalette(true)}>
                                <Search />
                                {t('shell:header.search')}
                            </HeaderMenuItem>
                            <Slot name="header.menu" props={{ moduleId }} />
                            {admin && (
                                <DropdownMenuItem className="h-8.5" onSelect={togglePause}>
                                    {paused ? <Play /> : <Pause />}
                                    {pauseLabel}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="h-8.5" onSelect={() => setPane(!pane)}>
                                <Monitor />
                                {pane ? t('shell:header.hide-computer') : t('shell:header.show-computer')}
                            </DropdownMenuItem>
                            <HeaderMenuPageSection />
                        </>
                    }
                />
                <Button
                    variant="ghost"
                    size="icon"
                    className="max-md:hidden"
                    aria-label={pane ? t('shell:header.hide-computer') : t('shell:header.show-computer')}
                    aria-expanded={pane}
                    onClick={() => setPane(!pane)}
                >
                    <Monitor className="size-4.5" />
                </Button>
            </div>
        </header>
    );
}
