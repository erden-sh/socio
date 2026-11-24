import { dateTimeFormat } from '@socio/shared/locale';
import type { RadarEntry, RadarOpenEntry, SpaceRadar } from '@socio/shared/pages/page-radar';
import type { SpaceMemoryState, SpaceMemoryView } from '@socio/shared/space-memory';

import type { BoundedItemState } from '../sync/bounded-kind';
import type { SpaceSection, SpaceSectionName } from '../sync/space-sections';

import { OPEN_ONLINE } from './page-reader';
import { UNTITLED_PAGE } from './space-library';

// A Space's radar and memory,
// read-only, as tabs of the Space's screen like the web's `space-tabs.tsx`
// (Pages, Memory, Radar; Settings stays on the web). The radar is the web's
// `SpaceRadar.tsx` (CB-282) without its session-only dismissals; the memory is
// `SpaceMemory.tsx` (CB-181): its proposals and entries in use, with who
// proposed and approved each, and none of its writes, which open the web. No
// React Native, so tests/shell runs it under Node.

/** The Space screen's tabs, in the web's order. */
export type SpaceTab = 'pages' | SpaceSectionName;

export const SPACE_TABS: readonly { readonly id: SpaceTab; readonly label: string }[] = [
    { id: 'pages', label: 'Pages' },
    { id: 'memory', label: 'Memory' },
    { id: 'radar', label: 'Radar' },
];

/** The web's path of a Space's section, for the memory's "Open on the web". */
export const spaceSectionPath = (spaceId: string, section: SpaceSectionName) =>
    `/spaces/${encodeURIComponent(spaceId)}/${section}`;

const day = dateTimeFormat({ month: 'short', day: 'numeric', year: 'numeric' });
const updatedTime = dateTimeFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** What a section shows besides its content: still loading, nothing offline, or an older copy. */
export type SectionStatus =
    | { readonly kind: 'loading' }
    | { readonly kind: 'offline'; readonly line: string }
    | { readonly kind: 'shown'; readonly note: string | null };

/** The web's line while a section loads. */
export const SECTION_LOADING: Record<SpaceSectionName, string> = {
    radar: 'Loading radar…',
    memory: 'Loading memory…',
};

/**
 * Where a section stands: its copy (with "Updated …" when the last read
 * failed, so an older copy says its age), "Open it once you're online" with
 * none after a failed read, else loading.
 */
export function sectionStatus(state: BoundedItemState<SpaceSection>): SectionStatus {
    if (state.value !== null) {
        const stale = state.failed && state.fetchedAt !== null;
        return { kind: 'shown', note: stale ? `Updated ${updatedTime.format(state.fetchedAt)}` : null };
    }
    if (state.failed || state.gone) {
        return { kind: 'offline', line: OPEN_ONLINE };
    }
    return { kind: 'loading' };
}

const titleOf = (entry: Pick<RadarEntry, 'title'>) => entry.title.trim() || UNTITLED_PAGE;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One page as a radar section lists it. */
export interface RadarRow {
    readonly id: string;
    readonly title: string;
    /** The excerpt, when the page has one. */
    readonly excerpt: string | null;
    /** "Nov 8, 2026 · 3 revisions kept", the open markers, or the stale age. */
    readonly meta: string;
    readonly accessibilityLabel: string;
}

/** One of the radar's three sections, with the web's words when it is empty. */
export interface RadarSection {
    readonly id: 'recent' | 'open' | 'stale';
    readonly title: string;
    readonly rows: readonly RadarRow[];
    readonly empty: string;
}

export interface RadarView {
    /** The web's scope line: how many pages, and what stale means. */
    readonly scope: string;
    readonly sections: readonly RadarSection[];
}

function edited(entry: RadarEntry): string {
    const kept = entry.revisions > 0 ? ` · ${plural(entry.revisions, 'revision', 'revisions')} kept` : '';
    return `${day.format(entry.updatedAt)}${kept}`;
}

function radarRow(entry: RadarEntry, meta: string): RadarRow {
    const title = titleOf(entry);
    const excerpt = entry.excerpt.trim() === '' ? null : entry.excerpt;
    return { id: entry.id, title, excerpt, meta, accessibilityLabel: `${title}, ${meta}` };
}

/** The stale age as the web words it. */
export const staleAge = (ageDays: number) =>
    ageDays === 0 ? 'Updated today' : `${plural(ageDays, 'day', 'days')} since the last edit`;

/** The radar's sections in the web's order and words. */
export function radarView(radar: SpaceRadar): RadarView {
    return {
        scope:
            `${plural(radar.total, 'live page', 'live pages')} in this Space. Stale is older than ` +
            `${radar.staleDays} days. Markers are a simple heuristic, not a deep scan.`,
        sections: [
            {
                id: 'recent',
                title: 'Recent changes',
                rows: radar.recent.map((entry) => radarRow(entry, edited(entry))),
                empty: 'No pages yet.',
            },
            {
                id: 'open',
                title: 'Open decisions & experiments',
                rows: radar.open.map((entry: RadarOpenEntry) =>
                    radarRow(entry, `${entry.markers.join(', ')} · ${edited(entry)}`),
                ),
                empty:
                    'Nothing flagged. A page shows here when its title or excerpt carries a marker like todo, ' +
                    'decision, experiment, tbd or unresolved.',
            },
            {
                id: 'stale',
                title: 'Potentially stale',
                rows: radar.stale.map((entry) => radarRow(entry, staleAge(entry.ageDays))),
                empty: `Nothing stale. Every page was updated within ${radar.staleDays} days.`,
            },
        ],
    };
}

/** One memory entry or proposal as the tab shows it. */
export interface MemoryRow {
    readonly id: string;
    readonly text: string;
    /** "Changes: “…”" for a proposal that changes an entry, else null. */
    readonly changes: string | null;
    /** "Version 2" past the first, else null. */
    readonly version: string | null;
    /** "Proposed by Mingo for Ada in Planning · Nov 8, 2026". */
    readonly proposed: string;
    /** "Approved by Ada · Nov 9, 2026" for an entry in use, else null. */
    readonly approved: string | null;
    readonly accessibilityLabel: string;
}

export interface MemoryView {
    /** Who reads the memory, and where proposals wait (the web's audience line). */
    readonly audience: string;
    /** "Waiting for approval" for an editor, "Your proposals" for a reader; no section with none. */
    readonly proposalsTitle: string;
    readonly proposals: readonly MemoryRow[];
    readonly entries: readonly MemoryRow[];
}

/** The web's provenance line: who proposed it (a socio for a person), in which chat, when. */
export function provenance(version: SpaceMemoryView): string {
    const who =
        version.dotName === null
            ? `Proposed by ${version.proposedByName}`
            : `Proposed by ${version.dotName} for ${version.proposedByName}`;
    const where = version.chatTitle !== null && version.threadId !== null ? ` in ${version.chatTitle}` : '';
    return `${who}${where} · ${day.format(version.createdAt)}`;
}

function memoryRow(version: SpaceMemoryView, entries: readonly SpaceMemoryView[], inUse: boolean): MemoryRow {
    const changed = version.supersedes === null ? null : entries.find((entry) => entry.id === version.supersedes)?.text;
    const changes = version.supersedes === null ? null : `Changes: “${changed ?? 'an earlier entry'}”`;
    const number = version.version ?? 1;
    const versionLabel = inUse && number > 1 ? `Version ${number}` : null;
    const approved = inUse
        ? `Approved by ${version.decidedByName ?? 'an editor'}${
              version.decidedAt === null ? '' : ` · ${day.format(version.decidedAt)}`
          }`
        : null;
    const proposed = provenance(version);
    return {
        id: version.id,
        text: version.text,
        changes,
        version: versionLabel,
        proposed,
        approved,
        accessibilityLabel: [changes, version.text, versionLabel, proposed, approved].filter(Boolean).join(', '),
    };
}

/** The memory's parts in the web's words; `isPrivate` is the Space's. */
export function memoryView(memory: SpaceMemoryState, isPrivate: boolean): MemoryView {
    const editor = memory.access === 'editor';
    return {
        audience: [
            isPrivate
                ? 'This Space is private: only its people and workspace admins read its memory.'
                : 'Everyone in the workspace reads this Space’s memory.',
            'Socios with this Space use matching entries in chats, and in a chat with other people only when every one of them can read it.',
            editor ? 'Socios’ proposals wait for you or another editor.' : 'What you propose waits for its editors.',
        ].join(' '),
        proposalsTitle: editor ? 'Waiting for approval' : 'Your proposals',
        proposals: memory.proposals.map((proposal) => memoryRow(proposal, memory.entries, false)),
        entries: memory.entries.map((entry) => memoryRow(entry, memory.entries, true)),
    };
}

/** The memory's empty line: the web's, without proposing from here. */
export const MEMORY_EMPTY =
    'Nothing yet. A socio with this Space can propose a lasting team fact, convention or decision, like “Invoices go out on the 1st”.';

/** Why the tab has no buttons: its writes are the web's. */
export const MEMORY_ON_THE_WEB = 'Approve, propose and change entries on the web.';
export const OPEN_ON_THE_WEB = 'Open on the web';
