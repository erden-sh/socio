import { ChevronDown, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { DEFAULT_BRANDING } from '@socio/shared/branding';
import type { ModuleId } from '@socio/shared/modules';
import type { Dot } from '@socio/shared/types';

import { useModules } from '../modules/context';
import { navGroups, sidebarEntries, slotEntries, type ModuleEntry } from '../modules/derive';
import type { ModuleContext, NavDialog, SidebarSection } from '../modules/types';
import { paletteShortcut, useUiHints } from '../shell/ui-hints';

import { NavUser } from './nav-user';
import { NavButton, SidebarNavContext, type SidebarNav } from './sidebar-nav';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    SidebarTrigger,
    useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export interface AppSidebarProps {
    context: ModuleContext;
    /** The Dot the main area is chatting with, highlighted on chat routes. */
    activeDotId?: string;
    onNewChat: () => void;
    onEditDot: (dot: Dot) => void;
    onCreateDot: () => void;
    onCreateSpace: () => void;
    onDialog: (dialog: NavDialog) => void;
    /** Opens the command palette. */
    onSearch: () => void;
    onSwitchUser: () => void;
    /** The current page's module, for the account menu's items. */
    moduleId?: ModuleId;
}

/** Socio's mark: the app icon (scripts/locals/app-icon.mjs), Sebas. */
function BrandMark({ logo }: { logo: string }) {
    return <img src={logo} alt="" aria-hidden className="size-8 shrink-0 rounded-lg object-contain" />;
}

/**
 * Collapsible sections, shown expanded by default. State is kept in the
 * browser's `localStorage` per person, so it survives reloads and is private
 * to this browser.
 */
const SIDEBAR_SECTIONS_KEY = 'socio:sidebar:sections';
const SECTION_ORDER: SidebarSection[] = ['workspace', 'apps', 'integrations', 'settings', 'platform', 'help'];
const SECTION_LABELS: Record<SidebarSection, string> = {
    workspace: 'Workspace',
    apps: 'Apps',
    integrations: 'Integrations',
    settings: 'Settings',
    platform: 'Platform',
    help: 'Help',
};

const DEFAULT_SECTIONS: Record<SidebarSection, boolean> = {
    workspace: true,
    apps: true,
    integrations: true,
    settings: true,
    platform: true,
    help: true,
};

function readSectionStates(userId: string | undefined): Partial<Record<SidebarSection, boolean>> {
    if (!userId || typeof localStorage === 'undefined') {
        return {};
    }
    try {
        return JSON.parse(localStorage.getItem(`${SIDEBAR_SECTIONS_KEY}:${userId}`) ?? '{}') as Partial<
            Record<SidebarSection, boolean>
        >;
    } catch {
        return {};
    }
}

function writeSectionStates(userId: string | undefined, states: Record<SidebarSection, boolean>) {
    if (!userId || typeof localStorage === 'undefined') {
        return;
    }
    try {
        localStorage.setItem(`${SIDEBAR_SECTIONS_KEY}:${userId}`, JSON.stringify(states));
    } catch {
        // Storage may be full or disabled; the in-memory state still works.
    }
}

function useSidebarSections(userId: string | undefined) {
    const [open, setOpen] = useState<Record<SidebarSection, boolean>>(() => ({
        ...DEFAULT_SECTIONS,
        ...readSectionStates(userId),
    }));
    useEffect(() => {
        setOpen({ ...DEFAULT_SECTIONS, ...readSectionStates(userId) });
    }, [userId]);
    const setSection = useCallback(
        (section: SidebarSection, value: boolean) => {
            setOpen((prev) => {
                const next = { ...prev, [section]: value };
                writeSectionStates(userId, next);
                return next;
            });
        },
        [userId],
    );
    return { open, setSection };
}

interface SectionGroupProps {
    section: SidebarSection;
    open: boolean;
    onOpenChange: (value: boolean) => void;
    collapsed: boolean;
    children: ReactNode;
    className?: string;
}

/**
 * One labeled sidebar section. When the whole sidebar is collapsed to icons
 * the label and chevron are hidden and every item stays visible as an icon.
 */
function SectionGroup({ section, open, onOpenChange, collapsed, children, className }: SectionGroupProps) {
    if (collapsed) {
        return (
            <SidebarGroup className={className}>
                <SidebarMenu>{children}</SidebarMenu>
            </SidebarGroup>
        );
    }
    const contentId = `sidebar-section-${section}`;
    return (
        <Collapsible open={open} onOpenChange={onOpenChange}>
            <SidebarGroup className={className}>
                <CollapsibleTrigger asChild>
                    <button
                        type="button"
                        data-section={section}
                        aria-expanded={open}
                        aria-controls={contentId}
                        className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground ring-sidebar-ring outline-hidden transition-[margin,opacity] focus-visible:ring-2 pointer-coarse:min-h-11 [&>svg]:size-4 [&>svg]:shrink-0"
                    >
                        <span>{SECTION_LABELS[section]}</span>
                        <ChevronDown
                            className={cn('size-4 shrink-0 transition-transform', open && '-rotate-180')}
                            aria-hidden
                        />
                    </button>
                </CollapsibleTrigger>
                <CollapsibleContent id={contentId} data-section={section}>
                    <SidebarMenu className="mt-1">{children}</SidebarMenu>
                </CollapsibleContent>
            </SidebarGroup>
        </Collapsible>
    );
}

/**
 * The workspace sidebar (shadcn's inset layout, like sidebar block 08): the
 * brand, New chat and Search, then the modules' groups (Dots, Spaces,
 * recent chats), grouped and collapsible sections for Workspace, Apps and
 * the bottom items, and the signed-in user in the footer. Every destination is
 * a link, active from the URL. Collapses to icons on desktop (⌘B / Ctrl+B)
 * and is a sheet on mobile.
 */
export function AppSidebar(props: AppSidebarProps) {
    const { context } = props;
    const { workspace, configured } = context;
    const brand = context.state.settings.branding ?? DEFAULT_BRANDING;
    const modules = useModules();
    const { setOpenMobile, state: sidebarState } = useSidebar();
    const collapsed = sidebarState === 'collapsed';
    const sectionState = useSidebarSections(workspace.user.id);
    const navigate = useNavigate();
    const shortcut = paletteShortcut(useUiHints());
    // Every destination closes the mobile sheet first.
    const close = () => setOpenMobile(false);
    const go =
        <Args extends unknown[]>(action: (...args: Args) => void) =>
        (...args: Args) => {
            close();
            action(...args);
        };
    const nav: SidebarNav = {
        context,
        activeDotId: props.activeDotId,
        close,
        go,
        onNewChat: props.onNewChat,
        onEditDot: props.onEditDot,
        onCreateDot: props.onCreateDot,
        onCreateSpace: props.onCreateSpace,
    };
    const items = sidebarEntries(modules, context);
    const bySection = useMemo(() => {
        const map = new Map<SidebarSection, ModuleEntry[]>();
        for (const section of SECTION_ORDER) {
            map.set(section, []);
        }
        for (const entry of items) {
            const section = entry.section ?? 'workspace';
            map.get(section)?.push(entry);
        }
        return map;
    }, [items]);
    const item = (entry: ModuleEntry, size?: 'sm') => {
        const opens = entry.opens;
        return (
            <SidebarMenuItem key={entry.id}>
                {'path' in opens ? (
                    <NavButton
                        to={opens.path}
                        reloadDocument={opens.reloadDocument}
                        activeBelow={opens.activeBelow}
                        size={size}
                        tooltip={entry.label}
                        data-tour={entry.id === 'help' ? 'help' : undefined}
                        onNavigate={close}
                    >
                        <entry.icon />
                        <span>{entry.label}</span>
                    </NavButton>
                ) : (
                    <SidebarMenuButton
                        size={size}
                        tooltip={entry.label}
                        onClick={go(() => props.onDialog(opens.dialog))}
                    >
                        <entry.icon />
                        <span>{entry.label}</span>
                    </SidebarMenuButton>
                )}
                {entry.badge !== undefined && <SidebarMenuBadge>{entry.badge}</SidebarMenuBadge>}
            </SidebarMenuItem>
        );
    };
    const renderItems = (section: SidebarSection, size?: 'sm') =>
        bySection.get(section)?.map((entry) => item(entry, size)) ?? [];
    const topSections: SidebarSection[] = ['workspace', 'apps'];
    const bottomSections: SidebarSection[] = ['integrations', 'settings', 'platform', 'help'];
    return (
        <SidebarNavContext.Provider value={nav}>
            <Sidebar variant="inset" collapsible="icon">
                <SidebarHeader>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg" tooltip={brand.name} asChild>
                                <Link to="/" aria-label={`${brand.name} home`} onClick={close}>
                                    <BrandMark logo={brand.logo} />
                                    <span className="grid flex-1 text-left leading-tight">
                                        <span className="truncate font-semibold">{brand.name}</span>
                                        {!configured && (
                                            <span className="truncate text-xs text-sidebar-muted-foreground">
                                                Setup required
                                            </span>
                                        )}
                                    </span>
                                </Link>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton tooltip="New chat" disabled={!configured} onClick={go(props.onNewChat)}>
                                <Plus />
                                <span>New chat</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                tooltip={`Search (${shortcut})`}
                                aria-label="Search"
                                aria-keyshortcuts="Meta+K Control+K"
                                onClick={go(props.onSearch)}
                            >
                                <Search />
                                <span>Search</span>
                                <kbd className="ml-auto rounded border group-data-[collapsible=icon]:hidden bg-sidebar px-1.5 font-sans text-[10px] text-sidebar-muted-foreground">
                                    {shortcut}
                                </kbd>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarHeader>
                <SidebarContent
                    role="navigation"
                    aria-label="Workspace"
                    // One scroll area with a thin, themed scrollbar. shadcn hides the
                    // overflow while collapsed; scroll instead, so many Dots never clip.
                    className="[scrollbar-color:var(--sidebar-border)_transparent] [scrollbar-width:thin] group-data-[collapsible=icon]:overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto"
                >
                    {/* Module groups: the Dots, the Spaces tree, recent chats. */}
                    {navGroups(modules, context).map(({ key, component: Group }) => (
                        <Group key={key} />
                    ))}
                    {topSections.map((section) => {
                        const children = renderItems(section, undefined);
                        if (!children.length) {
                            return null;
                        }
                        return (
                            <SectionGroup
                                key={section}
                                section={section}
                                open={sectionState.open[section]}
                                onOpenChange={(value) => sectionState.setSection(section, value)}
                                collapsed={collapsed}
                            >
                                {children}
                            </SectionGroup>
                        );
                    })}
                    <div className="mt-auto flex flex-col gap-2">
                        {bottomSections.map((section) => {
                            const children = renderItems(section, 'sm');
                            if (!children.length) {
                                return null;
                            }
                            return (
                                <SectionGroup
                                    key={section}
                                    section={section}
                                    open={sectionState.open[section]}
                                    onOpenChange={(value) => sectionState.setSection(section, value)}
                                    collapsed={collapsed}
                                >
                                    {children}
                                </SectionGroup>
                            );
                        })}
                    </div>
                </SidebarContent>
                <SidebarFooter>
                    <NavUser
                        user={workspace.user}
                        version={context.state.version}
                        onSwitchUser={go(props.onSwitchUser)}
                        onAccount={go(() => props.onDialog('account'))}
                        onReleaseNotes={go(() => void navigate('/releases'))}
                        items={slotEntries(modules, context, 'account.items').map(({ key, Component }) => (
                            <Component key={key} moduleId={props.moduleId} close={close} />
                        ))}
                    />
                </SidebarFooter>
                <SidebarRail />
            </Sidebar>
        </SidebarNavContext.Provider>
    );
}

/**
 * The header's sidebar toggle (shadcn's trigger, on theme tokens): collapses
 * on desktop, opens the sheet on mobile.
 */
export function SidebarToggle({ className }: { className?: string }) {
    const { isMobile, open, openMobile } = useSidebar();
    const label = isMobile ? 'Open navigation' : open ? 'Collapse sidebar' : 'Expand sidebar';
    return (
        <SidebarTrigger
            aria-label={label}
            aria-expanded={isMobile ? openMobile : open}
            title={`${label} (⌘B / Ctrl+B)`}
            className={cn('shrink-0', className)}
        />
    );
}
