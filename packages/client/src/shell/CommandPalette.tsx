import { Monitor, Moon, Plus, Sun } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import { foldText, PAGE_SEARCH_MIN_CHARS } from '@socio/shared/pages/page-search';
import { searchCommands } from '@socio/shared/search/rank';

import { useSearchAsYouType } from '../hooks/use-search-as-you-type';
import { onDemand } from '../i18n/on-demand';
import { useModuleContext, useModules } from '../modules/context';
import { moduleCommands, visibleModules } from '../modules/derive';
import type { PaletteActions, PaletteCommand, PaletteSearchAnswer } from '../modules/types';

import { navigateOrLoad } from './build-skew';
import { groupResults, mergeSearchResults } from './palette-search';
import { useShell } from './shell-context';
import { Snippet } from './Snippet';

import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
} from '@/components/ui/command';
import { useThemeChoice, useThemeChoices, type ThemeChoice } from '@/shell/theme';

const themeIcons: Record<ThemeChoice, PaletteCommand['icon']> = {
    light: Sun,
    dark: Moon,
    system: Monitor,
};

/**
 * Whether a ⌘K / Ctrl+K press should open the palette: not when something
 * already handled the key (an editor shortcut), and not from a rich-text
 * editor (the same guard as the sidebar's Ctrl+B).
 */
export function isPaletteShortcut(event: KeyboardEvent) {
    if (event.defaultPrevented) {
        return false;
    }
    if (event.target instanceof HTMLElement && event.target.isContentEditable) {
        return false;
    }
    return event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

/** Opens the palette on ⌘K / Ctrl+K; a second press closes it. */
export function usePaletteShortcut(toggle: () => void) {
    const onKey = useEffectEvent((event: KeyboardEvent) => {
        if (!isPaletteShortcut(event)) {
            return;
        }
        event.preventDefault();
        toggle();
    });
    useEffect(() => {
        const listener = (event: KeyboardEvent) => onKey(event);
        window.addEventListener('keydown', listener);
        return () => window.removeEventListener('keydown', listener);
    }, []);
}

/** The correction row's value: choosing it searches the words as typed. */
const EXACT = 'palette:exact';

/**
 * The palette's groups by the name commands give them (`PaletteCommand.group`,
 * the same in every language, so modules' commands share one), and the
 * heading each shows. A group not listed shows its name.
 */
const GROUP_HEADINGS = {
    Actions: 'actions',
    Theme: 'theme',
    'Go to': 'go-to',
    Apps: 'apps',
    Help: 'help',
    Issues: 'issues',
    Socios: 'socios',
    Rooms: 'rooms',
    'Recent chats': 'recent-chats',
    Spaces: 'spaces',
    Pages: 'pages',
} as const;
const knownGroup = (group: string): group is keyof typeof GROUP_HEADINGS => Object.hasOwn(GROUP_HEADINGS, group);

/**
 * The ⌘K command palette: modules ("Go to …"), Dots ("New chat with …"),
 * Spaces and pages, recent chats, issues and actions, all from the
 * registry; the shell adds New chat and the theme. Pages and issues are
 * fetched each time it opens and listed once something is typed. Modules
 * with a server search (pages by their text) add results as the user
 * types: below the instant ones, never moving them.
 */
export const CommandPalette = onDemand(
    ['shell.palette', 'shell.help'],
    function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
        const { t } = useTranslation(['shell.palette']);
        const heading = (group: string) =>
            knownGroup(group) ? t(`shell.palette:groups.${GROUP_HEADINGS[group]}`) : group;
        const themeChoices = useThemeChoices();
        const shell = useShell();
        const navigate = useNavigate();
        const modules = useModules();
        const context = useModuleContext();
        const { setChoice } = useThemeChoice();
        const [query, setQuery] = useState('');
        const [loaded, setLoaded] = useState<PaletteCommand[]>([]);
        // Fetched once per opening, with the context of that moment (the
        // workspace poll must not refetch them every 3 s).
        const load = useEffectEvent((signal: AbortSignal) =>
            Promise.all(
                visibleModules(modules, context).map(
                    (module) => module.loadCommands?.(context, signal).catch((): PaletteCommand[] => []) ?? [],
                ),
            ),
        );
        useEffect(() => {
            if (!open) {
                return;
            }
            const controller = new AbortController();
            void load(controller.signal).then((lists) => {
                if (!controller.signal.aborted) {
                    setLoaded(lists.flat());
                }
            });
            return () => controller.abort();
        }, [open]);
        const commands = useMemo<PaletteCommand[]>(
            () => [
                ...(context.configured
                    ? [
                          {
                              id: 'shell:new-chat',
                              label: t('shell.palette:new-chat'),
                              group: 'Actions',
                              hint: context.homeDot.name,
                              keywords: ['conversation', 'message'],
                              icon: Plus,
                              run: ({ shell: { newConversation, homeDot } }: PaletteActions) =>
                                  void newConversation(homeDot),
                          },
                      ]
                    : []),
                ...moduleCommands(modules, context),
                ...loaded,
                ...themeChoices.map(({ value, label }): PaletteCommand => ({
                    id: `theme:${value}`,
                    label: t('shell.palette:theme', { theme: label }),
                    group: 'Theme',
                    keywords: ['appearance', 'dark', 'light', 'mode'],
                    icon: themeIcons[value],
                    run: () => setChoice(value),
                })),
            ],
            [modules, context, loaded, setChoice, t, themeChoices],
        );
        // Server search: a moment after the last keystroke, for 2+ characters.
        const searchers = visibleModules(modules, context).filter((module) => module.search);
        const [exact, setExact] = useState(false);
        const folded = foldText(query);
        const remote = useSearchAsYouType<PaletteSearchAnswer[]>(
            searchers.length && folded.replaceAll(' ', '').length >= PAGE_SEARCH_MIN_CHARS
                ? `${exact ? 'exact' : 'any'}:${folded}`
                : null,
            (signal) =>
                Promise.all(
                    searchers.map((module) =>
                        module
                            .search!.run(context, query, { exact }, signal)
                            .catch((): PaletteSearchAnswer => ({ commands: [] })),
                    ),
                ),
            open,
        );
        const merged = mergeSearchResults(searchCommands(commands, query), remote.answer ?? []);
        const groups = groupResults(merged.results);
        const corrected = merged.corrected;
        // The highlighted entry: the user's, while it is still listed, else the
        // first result (so typing never leaves the list scrolled to an old one).
        const [picked, setPicked] = useState('');
        const shown = groups.flatMap((group) => group.items);
        const selected =
            shown.some((item) => item.id === picked) || (picked === EXACT && corrected) ? picked : (shown[0]?.id ?? '');
        const close = (next: boolean) => {
            onOpenChange(next);
            if (!next) {
                setQuery('');
                setPicked('');
                setExact(false);
            }
        };
        const run = (command: PaletteCommand) => {
            close(false);
            command.run({
                // After a deploy, a page load instead (build-skew.ts).
                navigate: navigateOrLoad((to) => void navigate(to)),
                open: shell.openTarget,
                shell,
            });
        };
        return (
            <CommandDialog
                open={open}
                onOpenChange={close}
                title={t('shell.palette:title')}
                description={t('shell.palette:description')}
                commandProps={{
                    shouldFilter: false,
                    loop: true,
                    value: selected,
                    onValueChange: setPicked,
                    label: t('shell.palette:title'),
                }}
            >
                <CommandInput
                    aria-label={t('shell.palette:title')}
                    placeholder={t('shell.palette:placeholder')}
                    value={query}
                    onValueChange={(next) => {
                        setQuery(next);
                        setPicked('');
                        setExact(false);
                    }}
                />
                <CommandList className="max-h-[min(420px,60svh)]">
                    <CommandEmpty>
                        {remote.pending
                            ? searchers.length === 1
                                ? searchers[0]!.search!.waiting
                                : t('shell.palette:searching')
                            : t('shell.palette:nothing')}
                    </CommandEmpty>
                    {groups.map(({ heading: group, items }) => (
                        <CommandGroup key={group} heading={heading(group)}>
                            {items.map((command) => {
                                const Icon = command.icon;
                                const correction = corrected &&
                                    corrected.group === group &&
                                    corrected.before === command.id && (
                                        <CommandItem
                                            key={EXACT}
                                            value={EXACT}
                                            data-slot="palette-correction"
                                            onSelect={() => {
                                                setExact(true);
                                                setPicked('');
                                            }}
                                        >
                                            <span className="grid min-w-0 flex-1">
                                                <span className="truncate">
                                                    <Trans
                                                        t={t}
                                                        i18nKey="shell.palette:corrected"
                                                        values={{ words: corrected.words }}
                                                        components={{ words: <strong className="font-medium" /> }}
                                                    />
                                                </span>
                                                <span className="truncate text-xs text-muted-foreground">
                                                    {t('shell.palette:search-instead', { query: query.trim() })}
                                                </span>
                                            </span>
                                        </CommandItem>
                                    );
                                const second = command.note || command.detail?.length;
                                return [
                                    correction,
                                    <CommandItem key={command.id} value={command.id} onSelect={() => run(command)}>
                                        {Icon && <Icon className="size-4" />}
                                        {second ? (
                                            <span className="grid min-w-0 flex-1">
                                                <span className="truncate">{command.label}</span>
                                                <span
                                                    className="truncate text-xs text-muted-foreground"
                                                    data-slot="palette-detail"
                                                >
                                                    {command.note}
                                                    {command.note && command.detail?.length ? ' · ' : ''}
                                                    {command.detail && <Snippet parts={command.detail} />}
                                                </span>
                                            </span>
                                        ) : (
                                            <span className="truncate">{command.label}</span>
                                        )}
                                        {command.hint && (
                                            <CommandShortcut className="tracking-normal">
                                                {command.hint}
                                            </CommandShortcut>
                                        )}
                                    </CommandItem>,
                                ];
                            })}
                        </CommandGroup>
                    ))}
                </CommandList>
            </CommandDialog>
        );
    },
);
