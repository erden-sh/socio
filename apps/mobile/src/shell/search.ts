import { STATUS_LABEL } from '@socio/shared/issues/issue-board';
import { issueKey as keyLabel, type IssueSummary } from '@socio/shared/issues/issue-types';
import { MODULE_IDS } from '@socio/shared/modules';
import { foldText, freshnessLabel, type PageHit } from '@socio/shared/pages/page-search';
import { PALETTE_GROUP_LIMIT, type RankedEntry, searchCommands } from '@socio/shared/search/rank';
import type { Role } from '@socio/shared/types';

import { type MoreItem, moreRows, type ShellPage } from '../navigation/tabs';
import { issueKey } from '../sync/issues';
import type { ServerSearchState } from '../sync/server-search';
import type { ToneName } from '../theme/theme';

import type { ChatRow } from './chat-list';
import type { SocioRow } from './home';
import type { MemoriesParams } from './memories';
import { type ModuleIconName, moduleEntry } from './modules';
import type { SpaceRow } from './spaces';

// The Search tab. With nothing typed, as the web's ⌘K palette opens: Actions
// (New chat with the default socio, Add memory, File an issue), then Go to
// (the modules with their tone tiles: Spaces, the Board, what More holds),
// then the socios and the recent chats and rooms (the chat list's rows, so its
// rules). Once the person types, everything is ranked by the web palette's
// ranking (shared's `searchCommands`): every word anywhere in a row's words,
// an exact key or name first ("CB-12", a socio's name), at most
// `PALETTE_GROUP_LIMIT` per section, the sections in the order of their best
// row. Typed searches add the issues by key, title and status (the `issues`
// kind) and the Spaces by name and description, and leave a hook for page
// titles held on the phone (`pages`, the page store's). From two characters
// the server's answers (`src/sync/server-search.ts`) follow the local rows the
// web's way (`mergeSearchResults`): `/api/issues/search` adds the issues whose
// description holds it after the local issue rows, and `/api/spaces/search`
// adds pages by their text, each opening the page reader. Offline the local
// rows show with "Searching page text needs a connection". No React Native, so
// tests/shell runs it under Node.

/** The recent chats and rooms Search lists while nobody has typed. */
export const RECENT_LIMIT = 8;

/** The line under the results while the server can't be asked. */
export const OFFLINE_LINE = 'Searching page text needs a connection';
/** The line while the server's answer is on its way. */
export const WAITING_LINE = 'Searching pages…';

/** Where a search row goes. */
export type SearchTarget =
    /** The Chats tab. */
    | { readonly kind: 'chats' }
    /** A page over the tabs: the Spaces or the Board. */
    | { readonly kind: 'page'; readonly name: ShellPage }
    /** A Space's library. */
    | { readonly kind: 'space'; readonly id: string }
    /** A page in the page reader (`pageAction`). */
    | { readonly kind: 'space-page'; readonly spaceId: string; readonly pageId: string }
    /** An issue's screen, by the store's key (its number). */
    | { readonly kind: 'issue'; readonly key: string }
    /** Filing an issue. */
    | { readonly kind: 'file-issue' }
    /** A new chat with a socio (the `NewChat` route). */
    | { readonly kind: 'new-chat'; readonly socioId: string }
    /** Adding a memory: Memories with its Add sheet open (`addMemoryAction`), as the web's palette opens its form. */
    | { readonly kind: 'add-memory' }
    /** A More module's page. */
    | { readonly kind: 'more'; readonly id: MoreItem; readonly label: string };

/** A row's icon: a module's, or an action's (the web palette's Plus and Bug). */
export type SearchIconName = ModuleIconName | 'Plus' | 'Bug';

/** A row that goes somewhere: its words, its icon (with a tone tile for a module) and where it goes. */
export interface SearchLink {
    readonly kind: 'link';
    readonly key: string;
    readonly label: string;
    /** A second line (an issue's key and status, a page's Space and text), or none. */
    readonly subtitle: string | null;
    readonly subtitleLines: number;
    readonly icon: SearchIconName;
    /** A module's tone, for its tile; none for All chats. */
    readonly tone: ToneName | null;
    readonly target: SearchTarget;
    readonly testID: string;
    readonly accessibilityLabel: string;
}

export interface SearchSocio {
    readonly kind: 'socio';
    readonly key: string;
    readonly socio: SocioRow;
}

export interface SearchChat {
    readonly kind: 'chat';
    readonly key: string;
    readonly chat: ChatRow;
}

export type SearchItem = SearchLink | SearchSocio | SearchChat;

export type SearchSectionId = 'actions' | 'socios' | 'recent' | 'spaces' | 'issues' | 'pages' | 'modules';

export interface SearchSection {
    readonly id: SearchSectionId;
    readonly title: string;
    readonly items: readonly SearchItem[];
}

/** A page title the phone holds (the page store's summaries), for the hook; none until a screen hands them in. */
export interface SearchPageTitle {
    readonly spaceId: string;
    readonly id: string;
    readonly title: string;
}

export interface SearchInput {
    /** What the person typed in Search. */
    readonly query: string;
    /** The chat list's rows (chat-list.ts), newest first. */
    readonly chats: readonly ChatRow[];
    /** Home's socios (home.ts). */
    readonly socios: readonly SocioRow[];
    /** The socio New chat starts with (first-run.ts `defaultSocioId`), with its name; none, no New chat. */
    readonly newChatWith?: { readonly id: string; readonly name: string } | null;
    /** The Spaces list's rows (spaces.ts); none by default. */
    readonly spaces?: readonly SpaceRow[];
    /** The `issues` collection's summaries, in any order; none by default. */
    readonly issues?: readonly IssueSummary[];
    /** Page titles held on the phone (the hook for the page store's); none by default. */
    readonly pages?: readonly SearchPageTitle[];
    /** The server's half (server-search.ts); idle by default. */
    readonly server?: ServerSearchState;
    readonly role: Role | null | undefined;
    /** For the pages' freshness; the device's clock by default. */
    readonly now?: number;
}

export interface SearchView {
    readonly sections: readonly SearchSection[];
    /** A search that matched nothing, with nothing more on its way. */
    readonly noMatches: boolean;
    /** `OFFLINE_LINE`, `WAITING_LINE` or none. */
    readonly serverLine: string | null;
}

const SPACES = moduleEntry(MODULE_IDS.spaces);
const ISSUES = moduleEntry(MODULE_IDS.issues);
const CHAT = moduleEntry(MODULE_IDS.chat);
const MEMORIES = moduleEntry(MODULE_IDS.memories);

const TITLES: Record<SearchSectionId, string> = {
    actions: 'Actions',
    socios: 'Socios',
    recent: 'Chats',
    spaces: SPACES.title,
    issues: 'Issues',
    pages: 'Pages',
    modules: 'Go to',
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

type LinkFields = Omit<SearchLink, 'kind' | 'accessibilityLabel' | 'subtitle' | 'subtitleLines'> &
    Partial<Pick<SearchLink, 'subtitle' | 'subtitleLines'>>;

function link(fields: LinkFields, spoken?: string): SearchLink {
    return {
        kind: 'link',
        subtitle: null,
        subtitleLines: 1,
        ...fields,
        accessibilityLabel: spoken ?? fields.label,
    };
}

/** An entry for the shared ranking, carrying its row and section. */
interface Entry extends RankedEntry {
    readonly group: SearchSectionId;
    readonly item: SearchItem;
}

function issueLink(issue: IssueSummary): SearchLink {
    const key = keyLabel(issue.number);
    const status = STATUS_LABEL[issue.status] ?? issue.status;
    return link(
        {
            key: `issue-${issue.number}`,
            label: issue.title,
            subtitle: `${key} · ${status}`,
            icon: ISSUES.icon,
            tone: ISSUES.tone,
            target: { kind: 'issue', key: issueKey(issue.number) },
            testID: `search-issue-${issue.number}`,
        },
        `${key}, ${issue.title}, ${status}`,
    );
}

function pageLink(page: SearchPageTitle, space: SpaceRow, hit?: PageHit, now?: number): SearchLink {
    const title = page.title.trim() === '' ? 'Untitled page' : page.title;
    const fresh = hit === undefined ? null : freshnessLabel(hit.freshness, now);
    const snippet =
        hit === undefined
            ? ''
            : hit.snippet
                  .map((part) => part.text)
                  .join('')
                  .replace(/\s+/g, ' ')
                  .trim();
    const first = fresh === null ? space.name : `${space.name} · ${fresh}`;
    return link(
        {
            key: `page-${page.id}`,
            label: title,
            subtitle: snippet === '' ? first : `${first}\n${snippet}`,
            subtitleLines: snippet === '' ? 1 : 2,
            icon: SPACES.icon,
            tone: SPACES.tone,
            target: { kind: 'space-page', spaceId: page.spaceId, pageId: page.id },
            testID: `search-page-${page.id}`,
        },
        [`${title}, page in ${space.name}`, fresh, snippet].filter((part) => part !== null && part !== '').join(', '),
    );
}

function moduleLinks(role: Role | null | undefined): SearchLink[] {
    return [
        link({
            key: 'spaces',
            label: SPACES.title,
            icon: SPACES.icon,
            tone: SPACES.tone,
            target: { kind: 'page', name: 'Spaces' },
            testID: 'search-spaces',
        }),
        link({
            key: 'board',
            label: 'Board',
            icon: ISSUES.icon,
            tone: ISSUES.tone,
            target: { kind: 'page', name: 'Board' },
            testID: 'search-board',
        }),
        ...moreRows(role).map((row) =>
            link({
                key: row.id,
                label: row.label,
                icon: row.icon,
                tone: row.tone,
                target: { kind: 'more', id: row.id, label: row.label },
                testID: `search-${row.id}`,
            }),
        ),
    ];
}

/** An action with the web palette's words for it, which a search matches besides its label. */
interface Action {
    readonly item: SearchLink;
    readonly keywords: readonly string[];
}

/**
 * The web palette's Actions, in its order: New chat with the default socio
 * (`shell:new-chat`, its name as the hint), Add memory (`memories:add`) and
 * File an issue (`issues:new`), each on its module's tone.
 */
function actions(input: SearchInput): Action[] {
    const socio = input.newChatWith ?? null;
    return [
        ...(socio === null
            ? []
            : [
                  {
                      item: link(
                          {
                              key: 'new-chat',
                              label: 'New chat',
                              subtitle: socio.name,
                              icon: 'Plus',
                              tone: CHAT.tone,
                              target: { kind: 'new-chat', socioId: socio.id },
                              testID: 'search-new-chat',
                          },
                          `New chat with ${socio.name}`,
                      ),
                      keywords: ['conversation', 'message'],
                  },
              ]),
        {
            item: link({
                key: 'add-memory',
                label: 'Add memory',
                icon: 'Plus',
                tone: MEMORIES.tone,
                target: { kind: 'add-memory' },
                testID: 'search-add-memory',
            }),
            keywords: ['new', 'memory', 'preference'],
        },
        {
            item: link({
                key: 'file-issue',
                label: 'File an issue',
                icon: 'Bug',
                tone: ISSUES.tone,
                target: { kind: 'file-issue' },
                testID: 'search-file-issue',
            }),
            keywords: ['report', 'bug', 'new', 'issue', 'feedback'],
        },
    ];
}

function idleView(input: SearchInput): SearchView {
    const recent: SearchItem[] = input.chats
        .slice(0, RECENT_LIMIT)
        .map((chat): SearchChat => ({ kind: 'chat', key: `chat-${chat.id}`, chat }));
    if (input.chats.length > 0) {
        recent.push(
            link(
                {
                    key: 'all-chats',
                    label: 'All chats',
                    icon: 'MessageCircle',
                    tone: null,
                    target: { kind: 'chats' },
                    testID: 'search-all-chats',
                },
                `All chats, ${plural(input.chats.length, 'chat')}`,
            ),
        );
    }
    const sections: SearchSection[] = [
        { id: 'actions', title: TITLES.actions, items: actions(input).map((action) => action.item) },
        { id: 'modules', title: TITLES.modules, items: moduleLinks(input.role) },
        {
            id: 'socios',
            title: TITLES.socios,
            items: input.socios.map((socio): SearchSocio => ({ kind: 'socio', key: `socio-${socio.id}`, socio })),
        },
        { id: 'recent', title: 'Recent', items: recent },
    ];
    return { sections: sections.filter((section) => section.items.length > 0), noMatches: false, serverLine: null };
}

export function searchView(input: SearchInput): SearchView {
    const folded = foldText(input.query);
    if (folded === '') {
        return idleView(input);
    }
    const spaces = input.spaces ?? [];
    const spaceById = new Map(spaces.map((space) => [space.id, space]));
    const issues = input.issues ?? [];

    const entries: Entry[] = [
        ...actions(input).map(({ item, keywords }): Entry => ({
            label: item.label,
            ...(item.subtitle === null ? {} : { hint: item.subtitle }),
            keywords: [...keywords],
            group: 'actions',
            item,
        })),
        ...input.socios.map((socio): Entry => ({
            label: socio.name,
            group: 'socios',
            item: { kind: 'socio', key: `socio-${socio.id}`, socio },
        })),
        ...input.chats.map((chat): Entry => ({
            label: chat.title,
            hint: chat.socio ?? '',
            group: 'recent',
            item: { kind: 'chat', key: `chat-${chat.id}`, chat },
        })),
        ...spaces.map((space): Entry => ({
            label: space.name,
            keywords: ['space', space.description ?? ''],
            group: 'spaces',
            item: link(
                {
                    key: `space-${space.id}`,
                    label: space.name,
                    icon: SPACES.icon,
                    tone: SPACES.tone,
                    target: { kind: 'space', id: space.id },
                    testID: `search-space-${space.id}`,
                },
                space.accessibilityLabel,
            ),
        })),
        ...[...issues]
            .sort((a, b) => b.number - a.number)
            .map((issue): Entry => {
                const key = keyLabel(issue.number);
                return {
                    label: issue.title,
                    hint: key,
                    keywords: [key, issue.status.replace(/_/g, ' ')],
                    group: 'issues',
                    searchOnly: true,
                    item: issueLink(issue),
                };
            }),
        ...(input.pages ?? []).flatMap((page): Entry[] => {
            const space = spaceById.get(page.spaceId);
            return space === undefined
                ? []
                : [
                      {
                          label: page.title.trim() === '' ? 'Untitled page' : page.title,
                          hint: space.name,
                          keywords: ['page'],
                          group: 'pages',
                          searchOnly: true,
                          item: pageLink(page, space),
                      },
                  ];
        }),
        ...moduleLinks(input.role).map((item): Entry => ({ label: item.label, group: 'modules', item })),
    ];

    const groups = new Map<SearchSectionId, SearchItem[]>();
    const listed = new Set<string>();
    for (const entry of searchCommands(entries, input.query)) {
        const items = groups.get(entry.group) ?? [];
        items.push(entry.item);
        groups.set(entry.group, items);
        listed.add(entry.item.key);
    }

    // The server's answer, only for this query (`mergeSearchResults`).
    const server = input.server ?? { status: 'idle' };
    const answer = server.status === 'done' && server.answer.query === folded ? server.answer : null;
    if (answer !== null) {
        const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
        const added = (answer.issues ?? []).flatMap((number) => {
            const issue = byNumber.get(number);
            return issue === undefined || listed.has(`issue-${number}`) ? [] : [issueLink(issue)];
        });
        if (added.length > 0) {
            groups.set('issues', [...(groups.get('issues') ?? []), ...added.slice(0, PALETTE_GROUP_LIMIT)]);
        }
        const hits = (answer.pages?.results ?? []).flatMap((hit) => {
            const space = spaceById.get(hit.spaceId);
            return space === undefined ? [] : [pageLink(hit, space, hit, input.now)];
        });
        const fromServer = new Map(hits.map((item) => [item.key, item]));
        const local = (groups.get('pages') ?? []).map((item) => fromServer.get(item.key) ?? item);
        const more = hits.filter((item) => !listed.has(item.key)).slice(0, PALETTE_GROUP_LIMIT);
        if (local.length + more.length > 0) {
            groups.set('pages', [...local, ...more]);
        }
    }

    const sections = [...groups].map(([id, items]): SearchSection => ({ id, title: TITLES[id], items }));
    const waiting = server.status === 'waiting' && server.query === folded;
    const offline = server.status === 'offline' && server.query === folded;
    return {
        sections,
        noMatches: sections.length === 0 && !waiting,
        serverLine: offline ? OFFLINE_LINE : waiting ? WAITING_LINE : null,
    };
}

/** Search's Add memory: Memories pushed with its Add sheet open, not the list to look for Add memory on. */
export const addMemoryAction = () =>
    ({ type: 'NAVIGATE', payload: { name: 'Memories', params: { add: true } satisfies MemoriesParams } }) as const;
