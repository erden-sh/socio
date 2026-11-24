import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import type { Issue, IssueLinkRef, IssueSummary } from '@socio/shared/issues/issue-types';
import type { ModuleId } from '@socio/shared/modules';
import type { SnippetPart } from '@socio/shared/pages/page-search';
import type { AgentRunSummary, Dot, State, WorkspaceState } from '@socio/shared/types';

import type { Shell } from '../shell/shell-context';

export type { ModuleId };

/**
 * What a module's predicates, badges and commands see: the shell's data
 * for the signed-in user (from the one workspace poll; modules never start
 * their own).
 */
export interface ModuleContext {
    admin: boolean;
    workspace: WorkspaceState;
    state: State;
    /** The model and conversation service are set up. */
    configured: boolean;
    /** The Dot the chat home shows: the last one opened, else the first. */
    homeDot: Dot;
}

/**
 * Who may use a module: `admin` for admins only, or a predicate (Telegram
 * only once it is configured). Hidden modules leave the sidebar, launcher
 * and palette, and their routes redirect to `/`. The server enforces access
 * on its own; this is navigation, not the control.
 */
export type ModuleAccess = 'admin' | ((context: ModuleContext) => boolean);

/** Dialogs the shell owns, which a module can open instead of a route. */
export type NavDialog = 'telegram' | 'settings' | 'account';

/** Where a module (or one of its entries) opens. */
export type ModuleTarget =
    | {
          path: string;
          reloadDocument?: boolean;
          /** The sidebar item stays active below `path` too (a plugin's deep links, CB-446). */
          activeBelow?: boolean;
      }
    | { dialog: NavDialog };

/** The identity tile color of a module (`tones.ts`). */
export type Tone = 'mint' | 'sky' | 'amber' | 'violet' | 'emerald' | 'orange' | 'slate' | 'indigo' | 'rose';

/** What a palette command can do when it runs. */
export interface PaletteActions {
    navigate: (to: string) => void;
    /** Opens a module target: navigates, or opens the shell's dialog. */
    open: (target: ModuleTarget) => void;
    shell: Shell;
}

/** One entry in the ⌘K palette. */
export interface PaletteCommand {
    /** Unique across the palette, e.g. `issues:CB-12`. */
    id: string;
    label: string;
    /** The palette group it is listed under ("Dots", "Pages", …). */
    group: string;
    /** Extra words it is found by (a Space's name for its pages, a status). */
    keywords?: readonly string[];
    icon?: ComponentType<{ className?: string }>;
    /** Shown at the end of the row (a key, a Dot's name). */
    hint?: string;
    /** Listed only once something is typed (pages, issues: too many to list). */
    searchOnly?: boolean;
    /**
     * A muted second line: `note` (a page's freshness, "Edited 3 days
     * ago"), then `detail` (a snippet; `match` parts are marked).
     */
    note?: string;
    detail?: readonly SnippetPart[];
    run: (actions: PaletteActions) => void;
}

/** What a module's server search found for the palette. */
export interface PaletteSearchAnswer {
    commands: PaletteCommand[];
    /** The words searched instead of a misspelt query, if any. */
    corrected?: string | null;
}

/**
 * Results a module's server finds as the user types (pages by their
 * text), merged below the instant ones in the same groups. The palette
 * asks a moment after the last keystroke and aborts stale requests.
 */
export interface PaletteSearch {
    /** Shown while the answer is out and nothing is listed ("Searching pages…"). */
    waiting: string;
    run: (
        context: ModuleContext,
        query: string,
        options: { exact: boolean },
        signal: AbortSignal,
    ) => Promise<PaletteSearchAnswer>;
}

/** The props each slot's contributions get. */
export interface SlotProps {
    /** Next to Pause, theme and computer in the header; `moduleId` is the page's module. */
    'header.actions': { moduleId?: ModuleId };
    /**
     * The same actions as items of the phone header's ⋯ menu, where
     * `header.actions` is hidden (its contributions stay mounted for their
     * shortcuts and dialogs). An item that opens something uses
     * `HeaderMenuItem` (shell/header-menu.tsx).
     */
    'header.menu': { moduleId?: ModuleId };
    /**
     * Items in the account menu (the sidebar footer), above Account
     * (Report issue). `moduleId` is the page's module; `close` closes the
     * mobile sidebar sheet before the item opens a dialog.
     */
    'account.items': { moduleId?: ModuleId; close: () => void };
    /** Per-run actions in the Runs view ("File issue"). */
    'run.actions': { run: AgentRunSummary };
    /** Widgets on the home launcher. */
    'home.widgets': Record<string, never>;
    /**
     * In an issue's detail, under its fields.
     * `refresh` reloads the issue after an action changed it.
     */
    'issue.actions': {
        issue: Issue;
        refresh: () => void;
        /** The issues it waits for (CB-29). */
        blockedBy?: readonly IssueLinkRef[];
    };
    /** Issues' Select mode bar, for admins too (batch actions). */
    'issues.batch': { issues: readonly IssueSummary[]; clear: () => void };
    /** Along the bottom of the Issues page. */
    'issues.footer': Record<string, never>;
    /**
     * Extra tabs on the Runs page, rendered twice
     * inside its `Tabs`: once with `part: 'trigger'` in the tab list (a
     * `TabsTrigger`), once with `part: 'content'` (the `TabsContent` with
     * the same value). The active tab is the page's `?tab=` (`turns` by
     * default), so a tab can be linked to.
     */
    'runs.tabs': { part: 'trigger' | 'content' };
    /**
     * Panels on a Dot's home page (CB-89, `/dots/:dotId`), in its columns:
     * Now (approvals waiting), Earlier (its filings) and Next (goals and
     * schedules). Each shows only the signed-in person's own (`DotPanel`).
     */
    'dot.present': { dot: Dot };
    'dot.past': { dot: Dot };
    'dot.future': { dot: Dot };
}
export type SlotName = keyof SlotProps;
export type SlotContributions = {
    [Name in SlotName]?: readonly ComponentType<SlotProps[Name]>[];
};

/** What a chat gives the tool renderers of the modules. */
export interface ToolRenderProps {
    threadId: string;
    /** The Dot the chat is with. */
    dot: Dot;
    /** Reloads the lists after the chat saved something (a page). */
    onSaved: () => void;
    /** Opens the Dot's computer pane, when the chat can. */
    onComputer?: () => void;
}

/**
 * How a module's agent tools (its server module's `dotTools`) show in a
 * chat. The chat renders these without knowing which module they are from;
 * they apply wherever a chat does, whoever may open the module's pages.
 */
export interface ToolRenderer {
    /**
     * Tools whose calls show as a card of their own in the transcript, not
     * as a step of the turn's trace.
     */
    cards?: readonly string[];
    /**
     * Mounted once in each chat, shows nothing: registers the module's
     * renderers with CopilotKit (`useHumanInTheLoop`, `useRenderTool`).
     */
    Register?: ComponentType<ToolRenderProps>;
    /**
     * Shown under the steps of an open trace: in the turn that holds the
     * chat's latest call to one of `tools` (the computer's screen).
     */
    afterSteps?: {
        tools: readonly string[];
        Component: ComponentType<ToolRenderProps>;
    };
}

/** A custom sidebar group (the Dots, the Spaces tree), placed by `order`. */
export interface NavGroup {
    order: number;
    component: ComponentType;
}

/** A section the sidebar groups and labels. */
export type SidebarSection = 'workspace' | 'apps' | 'integrations' | 'settings' | 'platform' | 'help';

/**
 * A client module: one folder under `packages/client/src/modules/` and one line in
 * `registry.ts`. The sidebar, breadcrumbs, launcher, palette and slots are
 * all derived from these manifests; nothing outside a module refers to it
 * by name, and modules never import each other. A module's pages are in
 * its `routes.ts` (one line in `modules/routes.ts`), not in the manifest.
 */
export interface ClientModule {
    /** Shared with the server module of the same feature (`packages/shared/src/modules.ts`). */
    id: ModuleId;
    /** The launcher card, palette and breadcrumb name. */
    title: string;
    /** The name members see, if it differs (Learning is Skills for them). */
    memberTitle?: string;
    /** The sidebar label, if it differs from the title. */
    navLabel?: string;
    /** One line for the launcher card and the palette. */
    description: string;
    memberDescription?: string;
    icon: LucideIcon;
    tone: Tone;
    /** Sidebar, launcher and palette order (ascending). */
    order: number;
    /** Where it opens: a path, one built from the shell data, or a dialog. */
    opens: ModuleTarget | ((context: ModuleContext) => ModuleTarget);
    access?: ModuleAccess;
    /** Which sidebar section this item belongs to, if any. */
    sidebar?: SidebarSection;
    /** Custom sidebar groups above the Workspace group. */
    navGroups?: readonly NavGroup[];
    /** Hidden from the home launcher's grid when false. */
    launcher?: boolean;
    /**
     * No "Go to" palette entry when false: a module with no page of its own
     * (the "Ask a socio" panel), whose commands say what it does instead.
     */
    goTo?: boolean;
    /** A count or status at the end of its sidebar row and on its card. */
    badge?: (context: ModuleContext) => string | number | undefined;
    /** Palette commands from the shell's data. */
    commands?: (context: ModuleContext) => PaletteCommand[];
    /** Palette commands fetched each time the palette opens (issues, pages). */
    loadCommands?: (context: ModuleContext, signal: AbortSignal) => Promise<PaletteCommand[]>;
    /** Palette results the server finds as the user types. */
    search?: PaletteSearch;
    slots?: SlotContributions;
    /** How this module's agent tools show in a chat. */
    toolRenderers?: ToolRenderer;
}
