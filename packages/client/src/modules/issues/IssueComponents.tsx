import { AppWindow, Plus, Puzzle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    compareComponents,
    ISSUE_COMPONENTS_MAX,
    WILDCARD_LABELS,
    type ComponentKind,
    type IssueComponentLabel,
    type IssueComponentOption,
    type IssueComponentOptions,
} from '@socio/shared/issues/issue-components';
import type { IssueEvent, IssueSummary } from '@socio/shared/issues/issue-types';
import { listFormat } from '@socio/shared/locale';
import { foldText } from '@socio/shared/pages/page-search';
import { pluginAddress } from '@socio/shared/plugins/plugins';

import { api } from '../../lib/api';

import { Field } from './IssueFields';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Issue components (CB-442): the plugins and apps an issue is about. Every
 * name shown here is one the server returned for this reader (the list's or
 * the detail's label map, or the picker's options); none is made from a ref.
 * Visibility is the server's: a ref the reader can't see never reaches the
 * client.
 */

/** How the labels for refs reach a view: `IssueList.components` or `IssueDetail.components`. */
export type ComponentLabels = Readonly<Record<string, IssueComponentLabel>>;

const NO_LABELS: ComponentLabels = {};

/** A plugin's icon (the Plugins module's) or an app's (the Apps module's). */
export const componentIcon = (kind: ComponentKind) => (kind === 'plugin' || kind === 'plugins' ? Puzzle : AppWindow);

/**
 * How a ref reads: from the label map, else from the picker's options (a
 * component just picked, before the server answers), else the fixed
 * wildcard names. Undefined when none has it.
 */
export function componentLabel(
    ref: string,
    labels: ComponentLabels = NO_LABELS,
    options?: readonly IssueComponentOption[],
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

/** The text for a ref: its label, or the ref itself when nothing names it. */
export const componentText = (ref: string, labels?: ComponentLabels, options?: readonly IssueComponentOption[]) =>
    componentLabel(ref, labels, options)?.label ?? ref;

/**
 * `componentText` in the reader's words: the two wildcards are this
 * client's (`issues.terms`), whatever name the server sent; every other
 * name is the one the server returned.
 */
export function useComponentText() {
    const { t } = useTranslation(['issues.terms']);
    return (ref: string, labels?: ComponentLabels, options?: readonly IssueComponentOption[]) =>
        ref === 'plugins:*'
            ? t('issues.terms:component.all-plugins')
            : ref === 'apps:*'
              ? t('issues.terms:component.all-apps')
              : componentText(ref, labels, options);
}

/** What a component's state adds after its name: its key in `issues.terms` (`component.state`). */
const STATE_NOTE: Record<IssueComponentLabel['state'], 'disabled' | 'uninstalled' | 'deleted' | undefined> = {
    live: undefined,
    disabled: 'disabled',
    uninstalled: 'uninstalled',
    deleted: 'deleted',
};

/** A state's note (`off`, `uninstalled`, `deleted`), none for a live one. */
function useStateNote() {
    const { t } = useTranslation(['issues.terms']);
    return (label: IssueComponentLabel | undefined) => {
        const note = label && STATE_NOTE[label.state];
        return note ? t(`issues.terms:component.state.${note}`) : undefined;
    };
}

/**
 * One component as a chip: its icon and name. A plugin that is gone or an
 * app that was deleted is muted (the name the tag kept, struck through), a
 * plugin that is off says so.
 */
export function ComponentChip({
    componentRef,
    labels,
    options,
    title,
    className,
}: {
    componentRef: string;
    labels?: ComponentLabels;
    options?: readonly IssueComponentOption[];
    /** Overrides the hover text (the triage proposal's). */
    title?: string;
    className?: string;
}) {
    const { t } = useTranslation(['issues.terms']);
    const label = componentLabel(componentRef, labels, options);
    const text = useComponentText()(componentRef, labels, options);
    const gone = label?.state === 'uninstalled' || label?.state === 'deleted';
    const Icon = componentIcon(label?.kind ?? (componentRef.startsWith('plugin') ? 'plugin' : 'app'));
    const note = useStateNote()(label);
    // The hover text: the name, its owner (apps) and its state.
    const owner = label?.ownerName;
    const hover = t('issues.terms:component.title', {
        name: text,
        owner: owner ?? '',
        note: note ?? '',
        context: owner ? (note ? 'owner-note' : 'owner') : note ? 'note' : undefined,
    });
    return (
        <span
            data-slot="issue-component"
            data-ref={componentRef}
            data-state={label?.state ?? 'live'}
            title={title ?? hover}
            className={cn(
                'inline-flex max-w-48 min-w-0 items-center gap-1 rounded-sm px-1.5 py-px text-xs leading-4 whitespace-nowrap',
                gone ? 'bg-muted/50 text-muted-foreground/70' : 'bg-muted text-muted-foreground',
                className,
            )}
        >
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className={cn('min-w-0 truncate', gone && 'line-through')}>{text}</span>
            {note && <span className="shrink-0 opacity-80">{t('issues.terms:component.note', { note })}</span>}
        </span>
    );
}

/**
 * An issue's components on a card or a row: two at most, then "+n" (the
 * rest named in its hover text).
 */
export function ComponentChips({
    refs,
    labels,
    max = 2,
}: {
    refs: readonly string[];
    labels?: ComponentLabels;
    max?: number;
}) {
    const text = useComponentText();
    if (!refs.length) {
        return null;
    }
    const shown = refs.slice(0, max);
    const rest = refs.slice(max);
    return (
        <>
            {shown.map((ref) => (
                <ComponentChip key={ref} componentRef={ref} labels={labels} />
            ))}
            {rest.length > 0 && (
                <span
                    data-slot="issue-components-more"
                    title={listFormat({ type: 'unit', style: 'short' }).format(rest.map((ref) => text(ref, labels)))}
                    className="rounded-sm bg-muted px-1.5 py-px text-xs leading-4 whitespace-nowrap text-muted-foreground"
                >
                    +{rest.length}
                </span>
            )}
        </>
    );
}

/**
 * The reader's choices (`GET /api/issues/components`): undefined while
 * loading; empty when the call failed (nothing can be picked then).
 */
export function useComponentOptions(enabled = true) {
    const [options, setOptions] = useState<IssueComponentOption[]>();
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const controller = new AbortController();
        api<IssueComponentOptions>('/issues/components', 'GET', undefined, controller.signal)
            .then((answer) => setOptions(answer.options))
            .catch(() => {
                if (!controller.signal.aborted) {
                    setOptions([]);
                }
            });
        return () => controller.abort();
    }, [enabled]);
    return options;
}

/**
 * The refs of a draft that are among the reader's options, so a prefill
 * never reveals or files what they can't pick. Nothing until the options
 * are known.
 */
export const draftedComponents = (refs: readonly string[] | undefined, options?: readonly IssueComponentOption[]) =>
    options ? (refs ?? []).filter((ref) => options.some((option) => option.ref === ref)) : [];

/**
 * What "Report issue" drafts on the current page (CB-442): a plugin's own
 * address (`/plugins/:pluginId` and everything under it, its deep links
 * included, CB-446) and its settings page (`/settings/plugins/:pluginId`)
 * are about that plugin. The form keeps it only when it is among the
 * reader's options.
 */
export function componentsOf(pathname: string): string[] | undefined {
    const settings = /^\/settings\/plugins\/([^/?#]+)\/?$/i.exec(pathname);
    const address = settings ? pluginAddress(`/plugins/${settings[1]}`) : pluginAddress(pathname);
    return address ? [`plugin:${address.pluginId}`] : undefined;
}

const GROUPS: { id: 'all' | 'plugins' | 'apps'; kinds: readonly ComponentKind[] }[] = [
    { id: 'all', kinds: ['plugins', 'apps'] },
    { id: 'plugins', kinds: ['plugin'] },
    { id: 'apps', kinds: ['app'] },
];

/** The options matching a search (name or owner, case and accents folded), grouped. */
export function groupOptions(options: readonly IssueComponentOption[], query: string) {
    const words = foldText(query).split(' ').filter(Boolean);
    const matching = options.filter((option) => {
        const text = foldText(`${option.label} ${option.ownerName ?? ''}`);
        return words.every((word) => text.includes(word));
    });
    return GROUPS.map((group) => ({
        id: group.id,
        options: matching.filter((option) => group.kinds.includes(option.kind)),
    })).filter((group) => group.options.length > 0);
}

/**
 * The components field (CB-442): the chosen ones as chips, each removable,
 * and "Add component", a searchable list grouped All, Plugins and Apps.
 * A chosen ref that is no longer an option (uninstalled, deleted) stays
 * shown, by the label map's name, and can still be removed. At most
 * `ISSUE_COMPONENTS_MAX`. Read-only chips when `disabled`.
 */
export function ComponentPicker({
    value,
    onChange,
    options,
    labels,
    disabled,
    className,
}: {
    value: readonly string[];
    onChange: (refs: string[]) => void;
    /** The reader's choices; undefined while loading. */
    options: readonly IssueComponentOption[] | undefined;
    labels?: ComponentLabels;
    disabled?: boolean;
    className?: string;
}) {
    const { t } = useTranslation(['issues.form']);
    const text = useComponentText();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const full = value.length >= ISSUE_COMPONENTS_MAX;
    const groups = groupOptions(options ?? [], query);
    const toggle = (ref: string, on: boolean) =>
        onChange(
            on ? (value.includes(ref) || full ? [...value] : [...value, ref]) : value.filter((item) => item !== ref),
        );
    return (
        <Field label={t('issues.form:components.label')} className={className}>
            {(id) => (
                <div role="group" aria-labelledby={id} data-slot="issue-components-field" className="grid gap-1.5">
                    {value.length > 0 ? (
                        <ul data-slot="issue-components-chosen" className="flex flex-wrap gap-1">
                            {value.map((ref) => (
                                <li key={ref} className="flex min-w-0 items-center">
                                    <ComponentChip
                                        componentRef={ref}
                                        labels={labels}
                                        options={options}
                                        className={disabled ? undefined : 'rounded-r-none'}
                                    />
                                    {!disabled && (
                                        <button
                                            type="button"
                                            aria-label={t('issues.form:components.remove', {
                                                name: text(ref, labels, options),
                                            })}
                                            className="flex h-[18px] items-center rounded-r-sm bg-muted px-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                                            onClick={() => toggle(ref, false)}
                                        >
                                            <X className="size-3" />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        disabled && (
                            <span className="text-sm text-muted-foreground">{t('issues.form:components.none')}</span>
                        )
                    )}
                    {!disabled && (
                        <Popover
                            open={open}
                            onOpenChange={(next) => {
                                setOpen(next);
                                if (!next) {
                                    setQuery('');
                                }
                            }}
                        >
                            <PopoverTrigger asChild>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    data-slot="issue-components-add"
                                    className="h-7 w-fit font-normal text-muted-foreground"
                                    disabled={!options?.length}
                                >
                                    <Plus />
                                    {options ? t('issues.form:components.add') : t('issues.form:components.loading')}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="w-72 p-0" data-slot="issue-components-picker">
                                <div className="border-b p-2">
                                    <Input
                                        type="search"
                                        aria-label={t('issues.form:components.search')}
                                        placeholder={t('issues.form:components.search-placeholder')}
                                        value={query}
                                        autoFocus
                                        className="h-8"
                                        onChange={(event) => setQuery(event.target.value)}
                                    />
                                </div>
                                <div className="max-h-72 overflow-y-auto p-1">
                                    {groups.length ? (
                                        groups.map((group) => (
                                            <div
                                                key={group.id}
                                                role="group"
                                                aria-label={t(`issues.form:components.group.${group.id}`)}
                                                data-slot="issue-components-group"
                                                className="grid py-1"
                                            >
                                                <span
                                                    aria-hidden
                                                    className="px-2 py-1 text-xs font-medium text-muted-foreground"
                                                >
                                                    {t(`issues.form:components.group.${group.id}`)}
                                                </span>
                                                {group.options.map((option) => {
                                                    const checked = value.includes(option.ref);
                                                    const Icon = componentIcon(option.kind);
                                                    return (
                                                        <label
                                                            key={option.ref}
                                                            data-slot="issue-components-option"
                                                            data-ref={option.ref}
                                                            className={cn(
                                                                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent',
                                                                !checked && full && 'cursor-not-allowed opacity-50',
                                                            )}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                className="size-3.5 accent-primary"
                                                                checked={checked}
                                                                disabled={!checked && full}
                                                                onChange={(event) =>
                                                                    toggle(option.ref, event.target.checked)
                                                                }
                                                            />
                                                            <Icon
                                                                aria-hidden
                                                                className="size-3.5 text-muted-foreground"
                                                            />
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {option.label}
                                                            </span>
                                                            {option.state === 'disabled' && (
                                                                <span className="text-xs text-muted-foreground">
                                                                    {t('issues.form:components.off')}
                                                                </span>
                                                            )}
                                                            {option.ownerName && (
                                                                <span className="max-w-24 truncate text-xs text-muted-foreground">
                                                                    {option.ownerName}
                                                                </span>
                                                            )}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        ))
                                    ) : (
                                        <p className="px-2 py-3 text-sm text-muted-foreground">
                                            {t('issues.form:components.no-match')}
                                        </p>
                                    )}
                                </div>
                                {full && (
                                    <p
                                        data-slot="issue-components-full"
                                        className="border-t px-3 py-2 text-xs text-muted-foreground"
                                    >
                                        {t('issues.form:components.full', { count: ISSUE_COMPONENTS_MAX })}
                                    </p>
                                )}
                            </PopoverContent>
                        </Popover>
                    )}
                </div>
            )}
        </Field>
    );
}

// --- The board's Component facet ---------------------------------------------

/**
 * The Component facet's values: the refs the label map names that are on
 * a listed issue (so no value matches nothing), plus any still chosen,
 * ordered wildcards, plugins, apps, then by name.
 */
export function componentFacetOptions(
    issues: readonly Pick<IssueSummary, 'components'>[],
    labels: ComponentLabels,
    chosen: readonly string[] = [],
) {
    const present = new Set(issues.flatMap((issue) => issue.components ?? []));
    const refs = Object.keys(labels).filter((ref) => present.has(ref) || chosen.includes(ref));
    return refs
        .map((ref) => ({ ref, label: labels[ref]!.label, kind: labels[ref]!.kind }))
        .sort(compareComponents)
        .map((item) => item.ref);
}

/**
 * The issues tagged with any of the chosen refs, exactly: "All plugins" is
 * its own value and matches only issues tagged with it (CB-442).
 */
export const filterByComponents = <T extends Pick<IssueSummary, 'components'>>(
    issues: readonly T[],
    chosen: readonly string[],
) => (chosen.length ? issues.filter((issue) => (issue.components ?? []).some((ref) => chosen.includes(ref))) : issues);

// --- History -----------------------------------------------------------------

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

/**
 * A components event in words, by the label map's names: "added the
 * component Forms", "removed the components CRM and All apps", or both,
 * after a semicolon.
 */
export function useComponentEventText() {
    const { t } = useTranslation(['issues.detail']);
    const text = useComponentText();
    return (event: Pick<IssueEvent, 'fromValue' | 'toValue'>, labels?: ComponentLabels) => {
        const before = refsOf(event.fromValue);
        const after = refsOf(event.toValue);
        const added = after.filter((ref) => !before.includes(ref)).map((ref) => text(ref, labels));
        const removed = before.filter((ref) => !after.includes(ref)).map((ref) => text(ref, labels));
        const addedText = added.length
            ? t('issues.detail:history.components-added', { count: added.length, names: added })
            : '';
        const removedText = removed.length
            ? t('issues.detail:history.components-removed', { count: removed.length, names: removed })
            : '';
        if (addedText && removedText) {
            return t('issues.detail:history.components-both', { added: addedText, removed: removedText });
        }
        return addedText || removedText || t('issues.detail:history.components');
    };
}
