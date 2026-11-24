import {
    compareComponents,
    isComponentRef,
    ISSUE_COMPONENTS_MAX,
    WILDCARD_LABELS,
    type ComponentKind,
    type IssueComponentLabel,
    type IssueComponentOption,
} from '@socio/shared/issues/issue-components';
import type { IssueEvent, IssueSummary } from '@socio/shared/issues/issue-types';
import { foldText } from '@socio/shared/pages/page-search';

// Issue components (CB-442): the
// plugins and apps an issue is about, on the phone. The web's rules
// (packages/client's IssueComponents.tsx, which isn't in shared), mirrored:
// - **Names** come only from the server: the list's or the detail's label map
//   (`IssueList.components`, `IssueDetail.components`), else the picker's
//   options (a ref just picked), else the two wildcards' fixed names. None is
//   made from a ref but the last resort, the ref's own id. A ref the reader
//   can't see never reaches the phone.
// - **States** read as the web words them: a plugin turned off says "off", an
//   uninstalled plugin or a deleted app keeps the name it was tagged with,
//   struck through, then "(uninstalled)" or "(deleted)".
// - **Chips**: two at most on a card or a row, then "+n".
// - **The picker** groups the reader's options as All, Plugins and Apps, at
//   most ISSUE_COMPONENTS_MAX chosen; a chosen ref no longer offered still
//   shows, by its label, and can be removed.
// - **The Board's facet**: the refs on the listed issues, exact match ("All
//   plugins" is its own value).
// - **History**: "added the component Forms", "removed the components CRM and
//   All apps", or both after a semicolon.
// No React Native: tests/shell runs it under Node.

/** How refs read for a view: the list's or the detail's label map. */
export type ComponentLabels = Readonly<Record<string, IssueComponentLabel>>;

const NO_LABELS: ComponentLabels = {};

export { ISSUE_COMPONENTS_MAX };

/** The Board's facet and the fields' row: the web's word. */
export const COMPONENTS_LABEL = 'Components';
/** The File an issue field and the picker's title (CB-442's "Plugins and apps"). */
export const COMPONENTS_PICKER_TITLE = 'Plugins and apps';
export const NO_COMPONENTS = 'None';
export const COMPONENTS_FULL = `At most ${ISSUE_COMPONENTS_MAX} components. Remove one to add another.`;
export const NO_MATCHING_COMPONENTS = 'No matching components.';
export const LOADING_COMPONENTS = 'Loading components…';
export const NO_COMPONENT_OPTIONS = 'No plugins or apps to choose from.';
export const SEARCH_COMPONENTS = 'Search plugins and apps';
/** The picker shows its search field past this many options. */
export const SEARCH_FROM = 9;

/** Whether a ref is a plugin's (or all plugins), for its icon. */
export const isPluginKind = (kind: ComponentKind) => kind === 'plugin' || kind === 'plugins';

/** A ref's kind from its form, when nothing names it. */
const kindOfRef = (ref: string): ComponentKind =>
    ref === 'plugins:*' ? 'plugins' : ref === 'apps:*' ? 'apps' : ref.startsWith('plugin:') ? 'plugin' : 'app';

/**
 * How a ref reads: from the label map, else from the picker's options (one
 * just picked, before the server answers), else the fixed wildcard names.
 * Undefined when none has it.
 */
export function componentLabel(
    ref: string,
    labels: ComponentLabels = NO_LABELS,
    options?: readonly IssueComponentOption[] | null,
): IssueComponentLabel | undefined {
    const known = labels[ref];
    if (known) {
        return known;
    }
    const option = options?.find((item) => item.ref === ref);
    if (option) {
        return {
            label: option.label,
            kind: option.kind,
            state: option.state ?? 'live',
            ...(option.ownerName ? { ownerName: option.ownerName } : {}),
        };
    }
    if (ref === 'plugins:*' || ref === 'apps:*') {
        return { label: WILDCARD_LABELS[ref], kind: ref === 'plugins:*' ? 'plugins' : 'apps', state: 'live' };
    }
    return undefined;
}

/** The id a ref names (`plugin:forms` is "forms"): only when nothing names it. */
const refId = (ref: string) => ref.slice(ref.indexOf(':') + 1).split('@')[0] || ref;

/** The words for a ref: its label, or its id when nothing names it. */
export const componentText = (
    ref: string,
    labels?: ComponentLabels,
    options?: readonly IssueComponentOption[] | null,
) => componentLabel(ref, labels, options)?.label ?? refId(ref);

/** What a state adds after the name (the web's STATE_NOTE). */
export const STATE_NOTE: Readonly<Record<IssueComponentLabel['state'], string | null>> = {
    live: null,
    disabled: 'off',
    uninstalled: 'uninstalled',
    deleted: 'deleted',
};

/** One component as a chip draws it. */
export interface ComponentChipView {
    readonly ref: string;
    readonly label: string;
    /** The plugin's icon or the app's. */
    readonly plugin: boolean;
    /** An uninstalled plugin or a deleted app: muted, its name struck through. */
    readonly gone: boolean;
    /** "(off)", "(uninstalled)", "(deleted)", or null. */
    readonly note: string | null;
    /** The web's hover text: "Component: CRM, owned by Ada, deleted". */
    readonly accessibilityLabel: string;
}

/** A ref as a chip. */
export function componentChip(
    ref: string,
    labels?: ComponentLabels,
    options?: readonly IssueComponentOption[] | null,
): ComponentChipView {
    const label = componentLabel(ref, labels, options);
    const text = label?.label ?? refId(ref);
    const state = label?.state ?? 'live';
    const note = STATE_NOTE[state];
    return {
        ref,
        label: text,
        plugin: isPluginKind(label?.kind ?? kindOfRef(ref)),
        gone: state === 'uninstalled' || state === 'deleted',
        note: note === null ? null : `(${note})`,
        accessibilityLabel: [
            `Component: ${text}`,
            ...(label?.ownerName ? [`owned by ${label.ownerName}`] : []),
            ...(note === null ? [] : [note]),
        ].join(', '),
    };
}

/** A card's or a row's components: two at most, then "+n" (the rest named for screen readers). */
export interface ComponentChipsView {
    readonly chips: readonly ComponentChipView[];
    readonly more: { readonly label: string; readonly accessibilityLabel: string } | null;
}

export function componentChips(
    refs: readonly string[] | undefined,
    labels?: ComponentLabels,
    max = 2,
    options?: readonly IssueComponentOption[] | null,
): ComponentChipsView {
    const all = refs ?? [];
    const rest = all.slice(max);
    return {
        chips: all.slice(0, max).map((ref) => componentChip(ref, labels, options)),
        more:
            rest.length === 0
                ? null
                : {
                      label: `+${rest.length}`,
                      accessibilityLabel: `And ${rest.map((ref) => componentText(ref, labels, options)).join(', ')}`,
                  },
    };
}

/** Every component's words for a screen reader's row label: "Components: Forms, CRM". */
export const componentsSpoken = (refs: readonly string[] | undefined, labels?: ComponentLabels) =>
    refs?.length ? [`Components: ${refs.map((ref) => componentText(ref, labels)).join(', ')}`] : [];

// ---- The picker ---------------------------------------------------------------

const GROUPS: readonly { readonly title: string; readonly kinds: readonly ComponentKind[] }[] = [
    { title: 'All', kinds: ['plugins', 'apps'] },
    { title: 'Plugins', kinds: ['plugin'] },
    { title: 'Apps', kinds: ['app'] },
];

/** The options matching a search (name or owner, case and accents folded), grouped All, Plugins, Apps. */
export function groupOptions(options: readonly IssueComponentOption[], query: string) {
    const words = foldText(query).split(' ').filter(Boolean);
    const matching = options.filter((option) => {
        const text = foldText(`${option.label} ${option.ownerName ?? ''}`);
        return words.every((word) => text.includes(word));
    });
    return GROUPS.map((group) => ({
        title: group.title,
        options: matching.filter((option) => group.kinds.includes(option.kind)),
    })).filter((group) => group.options.length > 0);
}

/** One option in the picker. */
export interface ComponentChoice {
    readonly ref: string;
    readonly label: string;
    readonly plugin: boolean;
    /** An app's owner, shown after its name. */
    readonly detail: string | null;
    readonly selected: boolean;
    /** Ten are chosen and this one isn't. */
    readonly disabled: boolean;
    readonly accessibilityLabel: string;
    readonly testID: string;
}

export interface ComponentPickerInput {
    /** The options' bounded item (issue-component-options.ts). */
    readonly list: {
        readonly value: { readonly options: readonly IssueComponentOption[] } | null;
        readonly fetchedAt: number | null;
        readonly settled: boolean;
        readonly failed: boolean;
    };
    /** What is chosen now. */
    readonly value: readonly string[];
    /** The view's label map, for chosen refs no longer offered. */
    readonly labels?: ComponentLabels;
    readonly query: string;
    readonly timeZone?: string;
}

export interface ComponentPickerView {
    readonly groups: readonly { readonly title: string; readonly choices: readonly ComponentChoice[] }[];
    /** Chosen refs that aren't options any more (uninstalled, deleted, hidden from a search): removable. */
    readonly others: readonly ComponentChoice[];
    readonly full: string | null;
    /** "Loading components…", "Needs a connection", or no options at all. */
    readonly line: string | null;
    /** The kept list's age when it couldn't be read again: "Saved Nov 8, 3:45 PM". */
    readonly age: string | null;
    readonly searchable: boolean;
    /** "No matching components." for a search that finds none. */
    readonly empty: string | null;
}

const savedAt = (ms: number, timeZone?: string) =>
    `Saved ${new Date(ms).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone === undefined ? {} : { timeZone }),
    })}`;

const NEEDS_CONNECTION = 'Needs a connection';

/** The picker as the sheet draws it: the groups, the chosen ones not offered, and its line. */
export function componentPicker(input: ComponentPickerInput): ComponentPickerView {
    const { list, value, labels, query, timeZone } = input;
    const options = list.value?.options ?? [];
    const full = value.length >= ISSUE_COMPONENTS_MAX;
    const choiceOf = (ref: string, label: string, kind: ComponentKind, detail: string | null): ComponentChoice => {
        const selected = value.includes(ref);
        const disabled = !selected && full;
        return {
            ref,
            label,
            plugin: isPluginKind(kind),
            detail,
            selected,
            disabled,
            accessibilityLabel: [label, ...(detail === null ? [] : [detail])].join(', '),
            testID: `component-choice-${ref}`,
        };
    };
    const groups = groupOptions(options, query).map((group) => ({
        title: group.title,
        choices: group.options.map((option) =>
            choiceOf(
                option.ref,
                option.label,
                option.kind,
                [option.state === 'disabled' ? 'off' : null, option.ownerName ?? null].filter(Boolean).join(' · ') ||
                    null,
            ),
        ),
    }));
    const offered = new Set(options.map((option) => option.ref));
    const others = value
        .filter((ref) => !offered.has(ref))
        .map((ref) => {
            const chip = componentChip(ref, labels, options);
            return choiceOf(ref, chip.label, chip.plugin ? 'plugin' : 'app', chip.note);
        });
    const loading = !list.settled && list.value === null;
    return {
        groups,
        others,
        full: full ? COMPONENTS_FULL : null,
        line: list.failed
            ? NEEDS_CONNECTION
            : loading
              ? LOADING_COMPONENTS
              : list.value !== null && options.length === 0
                ? NO_COMPONENT_OPTIONS
                : null,
        age: list.failed && list.fetchedAt !== null ? savedAt(list.fetchedAt, timeZone) : null,
        searchable: options.length >= SEARCH_FROM,
        empty: options.length > 0 && groups.length === 0 ? NO_MATCHING_COMPONENTS : null,
    };
}

/** A ref turned on or off: on only while fewer than ten are chosen. */
export function toggleComponent(value: readonly string[], ref: string): string[] {
    if (value.includes(ref)) {
        return value.filter((item) => item !== ref);
    }
    return value.length >= ISSUE_COMPONENTS_MAX ? [...value] : [...value, ref];
}

/** Refs as kept (a draft, the Board's choices): valid ones only, each once, at most `max`. */
export function keptComponents(value: unknown, max = ISSUE_COMPONENTS_MAX): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const refs = value.filter((ref): ref is string => typeof ref === 'string' && isComponentRef(ref));
    return [...new Set(refs)].slice(0, max);
}

// ---- The Board's facet ----------------------------------------------------------

/**
 * The Component facet's values: the refs the label map names that are on a
 * listed issue (so none matches nothing), plus any still chosen, ordered
 * wildcards, plugins, apps, then by name.
 */
export function componentFacetOptions(
    issues: readonly Pick<IssueSummary, 'components'>[],
    labels: ComponentLabels,
    chosen: readonly string[] = [],
): string[] {
    const present = new Set(issues.flatMap((issue) => issue.components ?? []));
    const refs = new Set([...Object.keys(labels).filter((ref) => present.has(ref)), ...chosen]);
    return [...refs]
        .map((ref) => {
            const label = componentLabel(ref, labels);
            return { ref, label: label?.label ?? refId(ref), kind: label?.kind ?? kindOfRef(ref) };
        })
        .sort(compareComponents)
        .map((item) => item.ref);
}

/** The issues tagged with any of the chosen refs, exactly. */
export const filterByComponents = <T extends Pick<IssueSummary, 'components'>>(
    issues: readonly T[],
    chosen: readonly string[],
): readonly T[] =>
    chosen.length ? issues.filter((issue) => (issue.components ?? []).some((ref) => chosen.includes(ref))) : issues;

// ---- History ------------------------------------------------------------------

const refsOf = (raw: string | null): string[] => {
    if (!raw) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
};

const listed = (names: readonly string[]) =>
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** A components event in the web's words, by the label map's names. */
export function componentEventText(event: Pick<IssueEvent, 'fromValue' | 'toValue'>, labels?: ComponentLabels) {
    const before = refsOf(event.fromValue);
    const after = refsOf(event.toValue);
    const added = after.filter((ref) => !before.includes(ref)).map((ref) => componentText(ref, labels));
    const removed = before.filter((ref) => !after.includes(ref)).map((ref) => componentText(ref, labels));
    const part = (verb: string, names: string[]) =>
        `${verb} the ${names.length === 1 ? 'component' : 'components'} ${listed(names)}`;
    const parts = [added.length ? part('added', added) : '', removed.length ? part('removed', removed) : ''].filter(
        Boolean,
    );
    return parts.length ? parts.join('; ') : 'changed the components';
}
