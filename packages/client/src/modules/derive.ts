import { AppWindow, Puzzle, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import type {
    ClientModule,
    ModuleContext,
    ModuleId,
    ModuleTarget,
    PaletteCommand,
    SidebarSection,
    SlotName,
    SlotProps,
    Tone,
    ToolRenderer,
} from './types';

/**
 * Everything the shell derives from the registry, as plain functions of the
 * module list and the user's context (tested in
 * `packages/client/tests/client-modules.test.tsx`).
 */

/** Whether this user may use the module (see `ModuleAccess`). */
export function canUse(module: ClientModule, context: ModuleContext) {
    const { access } = module;
    if (!access) {
        return true;
    }
    if (access === 'admin') {
        return context.admin;
    }
    return access(context);
}

/** The modules this user may use, in order. */
export function visibleModules(modules: readonly ClientModule[], context: ModuleContext) {
    return modules.filter((module) => canUse(module, context)).sort((a, b) => a.order - b.order);
}

export const moduleTitle = (module: ClientModule, context: ModuleContext) =>
    (!context.admin && module.memberTitle) || module.title;

export const moduleDescription = (module: ClientModule, context: ModuleContext) =>
    (!context.admin && module.memberDescription) || module.description;

export const moduleTarget = (module: ClientModule, context: ModuleContext): ModuleTarget =>
    typeof module.opens === 'function' ? module.opens(context) : module.opens;

const badgeText = (module: ClientModule, context: ModuleContext) => {
    const badge = module.badge?.(context);
    return badge === undefined ? undefined : String(badge);
};

/** A module as the sidebar, launcher and palette show it to one user. */
export interface ModuleEntry {
    /** A module's id, `app:<id>` for a promoted mini app, or `plugin:<id>`. */
    id: ModuleId | `app:${string}` | `plugin:${string}`;
    label: string;
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
    opens: ModuleTarget;
    section?: SidebarSection;
    badge?: string;
}

function entry(module: ClientModule, context: ModuleContext): ModuleEntry {
    const title = moduleTitle(module, context);
    return {
        id: module.id,
        // Members' names win over the sidebar's short label (Skills).
        label: (!context.admin && module.memberTitle) || module.navLabel || title,
        title,
        description: moduleDescription(module, context),
        icon: module.icon,
        tone: module.tone,
        opens: moduleTarget(module, context),
        section: module.sidebar,
        badge: badgeText(module, context),
    };
}

/**
 * Promoted mini apps as registry entries, generated from the server's
 * list (`/api/workspace`'s `workspaceApps`: the user's own and those shared
 * with their Spaces). Each opens the app through its sign-in hand-off.
 */
export function workspaceAppEntries(context: ModuleContext): ModuleEntry[] {
    return (context.workspace.workspaceApps ?? []).map((app) => ({
        id: `app:${app.id}`,
        label: app.name,
        title: app.name,
        description:
            app.description ||
            `A workspace app from ${app.dotName}${app.owner ? '' : app.sharedSpaceName ? `, shared with ${app.sharedSpaceName}` : ''}.`,
        icon: AppWindow,
        tone: 'violet',
        opens: { path: `/apps/${encodeURIComponent(app.id)}/open` },
        section: 'apps',
    }));
}

/**
 * Installed, enabled plugins this person may use (the server sends only
 * those in each plugin's audience, members included). Each opens at
 * `/plugins/:id`: a bundled plugin and an embed inside the workspace; a tab
 * plugin's page asks for a launch code and opens the apps host in a new
 * tab. Only a service embed is a document navigation, so that route's
 * `frame-src` applies. The item stays highlighted on the plugin's deep
 * links, `/plugins/:id/*` (CB-446).
 */
export function pluginEntries(context: ModuleContext): ModuleEntry[] {
    return (context.workspace.plugins ?? []).map((plugin) => ({
        id: `plugin:${plugin.id}`,
        label: plugin.name,
        title: plugin.name,
        description: plugin.description,
        icon: Puzzle,
        tone: 'violet',
        opens: {
            path: `/plugins/${encodeURIComponent(plugin.id)}`,
            reloadDocument: plugin.mode !== 'bundled' && plugin.display === 'embed',
            activeBelow: true,
        },
        section: 'apps',
    }));
}

/**
 * The sidebar's module items, grouped by section. Workspace apps and plugins
 * get their own Apps section so they don't mix into the main navigation.
 */
export function sidebarEntries(modules: readonly ClientModule[], context: ModuleContext): ModuleEntry[] {
    return [
        ...visibleModules(modules, context)
            .filter((module) => module.sidebar)
            .map((module) => entry(module, context)),
        ...workspaceAppEntries(context),
        ...pluginEntries(context),
    ];
}

/** The custom sidebar groups, in order. */
export function navGroups(
    modules: readonly ClientModule[],
    context: ModuleContext,
): { key: string; component: ComponentType }[] {
    return visibleModules(modules, context)
        .flatMap((module) =>
            (module.navGroups ?? []).map((group, index) => ({
                key: `${module.id}:${index}`,
                ...group,
            })),
        )
        .sort((a, b) => a.order - b.order);
}

/** The home launcher's module cards. */
export function launcherCards(modules: readonly ClientModule[], context: ModuleContext): ModuleEntry[] {
    return [
        ...visibleModules(modules, context)
            .filter((module) => module.launcher !== false)
            .map((module) => entry(module, context)),
        ...workspaceAppEntries(context),
        ...pluginEntries(context),
    ];
}

/** A "Go to" palette entry per visible module, then the modules' own commands. */
export function moduleCommands(modules: readonly ClientModule[], context: ModuleContext): PaletteCommand[] {
    const visible = visibleModules(modules, context);
    const goTo = visible
        .filter((module) => module.goTo !== false)
        .map((module): PaletteCommand => {
            const { title, description, icon, opens, label } = entry(module, context);
            return {
                id: `module:${module.id}`,
                label: `Go to ${title}`,
                group: 'Go to',
                keywords: [label, description, module.id],
                icon,
                run: ({ open }) => open(opens),
            };
        });
    const apps = [...workspaceAppEntries(context), ...pluginEntries(context)].map((app): PaletteCommand => ({
        id: app.id,
        label: `Open ${app.title}`,
        group: 'Apps',
        keywords: [app.title, app.description],
        icon: app.icon,
        run: ({ open }) => open(app.opens),
    }));
    return [...goTo, ...apps, ...visible.flatMap((module) => module.commands?.(context) ?? [])];
}

/** One slot contribution, with the module it came from. */
export interface SlotEntry<Name extends SlotName> {
    key: string;
    moduleId: ModuleId;
    Component: ComponentType<SlotProps[Name]>;
}

/** A slot's contributions from the modules this user may use, in order. */
export function slotEntries<Name extends SlotName>(
    modules: readonly ClientModule[],
    context: ModuleContext,
    name: Name,
): SlotEntry<Name>[] {
    return visibleModules(modules, context).flatMap((module) =>
        (module.slots?.[name] ?? []).map((Component, index) => ({
            key: `${module.id}:${name}:${index}`,
            moduleId: module.id,
            Component: Component as ComponentType<SlotProps[Name]>,
        })),
    );
}

/** The tool renderers the modules contribute, in registry order. */
export function toolRenderers(modules: readonly ClientModule[]): Array<ToolRenderer & { moduleId: ModuleId }> {
    return modules.flatMap((module) =>
        module.toolRenderers ? [{ ...module.toolRenderers, moduleId: module.id }] : [],
    );
}
