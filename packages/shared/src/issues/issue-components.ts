import { compareText } from '../locale.js';

/**
 * Issue components (CB-442): which
 * plugins or apps an issue is about. A component is a ref: `plugin:<id>`,
 * `app:<id>`, or one of the two wildcards, `plugins:*` (all plugins) and
 * `apps:*` (all apps). A tag of an app that was deleted (or whose address a
 * newer app took) reads as `app:<id>@<generation>`, so it never names the
 * next app with that address.
 *
 * Shared by the server, the web client and mobile.
 */

export const COMPONENT_KINDS = ['plugins', 'apps', 'plugin', 'app'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** The two wildcards, in the order pickers list them. */
export const COMPONENT_WILDCARDS = ['plugins:*', 'apps:*'] as const;
export type ComponentWildcard = (typeof COMPONENT_WILDCARDS)[number];
export const WILDCARD_LABELS: Record<ComponentWildcard, string> = {
    'plugins:*': 'All plugins',
    'apps:*': 'All apps',
};

/** The most components one issue carries. */
export const ISSUE_COMPONENTS_MAX = 10;

/**
 * Where a tag's target is now: `live`; `disabled` (an installed plugin an
 * admin turned off, shown to admins); `uninstalled` (a plugin); `deleted`
 * (an app). The last two read from the name the tag kept.
 */
export const COMPONENT_STATES = ['live', 'disabled', 'uninstalled', 'deleted'] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** How a ref reads for one reader: `IssueList.components` and `IssueDetail.components`. */
export interface IssueComponentLabel {
    label: string;
    kind: ComponentKind;
    state: ComponentState;
    /** Apps: the owner's name (CB-442). */
    ownerName?: string;
}

/** `GET /api/issues/components`: one choice in the picker. */
export interface IssueComponentOption {
    ref: string;
    label: string;
    kind: ComponentKind;
    /** Admins only: an installed plugin that is turned off. */
    state?: Extract<ComponentState, 'live' | 'disabled'>;
    /** Apps: the owner's name. */
    ownerName?: string;
}

export interface IssueComponentOptions {
    options: IssueComponentOption[];
}

/** The id rule refs share with socio audiences (`actor-scopes.ts`). */
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}';
const REF = new RegExp(`^(?:plugins:\\*|apps:\\*|plugin:${ID}|app:${ID}(?:@[1-9]\\d{0,15})?)$`);

/** A ref's parts, or undefined for anything that isn't one. */
export function parseComponentRef(
    value: string,
): { kind: ComponentKind; id: string | null; generation: number | null } | undefined {
    if (typeof value !== 'string' || !REF.test(value)) {
        return undefined;
    }
    if (value === 'plugins:*') {
        return { kind: 'plugins', id: null, generation: null };
    }
    if (value === 'apps:*') {
        return { kind: 'apps', id: null, generation: null };
    }
    const colon = value.indexOf(':');
    const kind = value.slice(0, colon) as 'plugin' | 'app';
    const [id, generation] = value.slice(colon + 1).split('@') as [string, string | undefined];
    return { kind, id, generation: generation === undefined ? null : Number(generation) };
}

export const isComponentRef = (value: string) => !!parseComponentRef(value);

/** Wildcards, then plugins, then apps; by label within each. */
export function compareComponents(
    a: { ref: string; label: string; kind: ComponentKind },
    b: { ref: string; label: string; kind: ComponentKind },
) {
    return (
        COMPONENT_KINDS.indexOf(a.kind) - COMPONENT_KINDS.indexOf(b.kind) ||
        compareText(a.label, b.label) ||
        compareText(a.ref, b.ref)
    );
}
