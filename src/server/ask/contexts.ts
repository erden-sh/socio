import type { DatabaseSync } from 'node:sqlite';

import type { AskContext, AskContextRef } from '@socio/shared/ask';
import { issueKey, type Issue } from '@socio/shared/issues/issue-types';
import { folderContext } from '@socio/shared/pages/page-library';

import type { DataSpaceShape } from '../dataspace/contract.js';
import type { PageMovesShape, PageStoreShape } from '../pages/contract.js';
import type { SchedulesShape } from '../schedules/contract.js';
import type { SpaceAccessShape } from '../spaces/contract.js';
import type { ConversationsShape, SociosShape, SpacesShape } from '../workspace/contract.js';

/**
 * What the panel reads of the Board: an issue by its number (`BoardShape`'s
 * `issues.get`). Ask declares it rather than importing the issues'
 * contract, which sits above it in the folder order
 * (scripts/feature-ranks.json); the Board answers it.
 */
export interface AskBoardShape {
    readonly issues: { get(number: number): Promise<Issue | undefined> };
}

/**
 * What the panel reads of other features: slices of their tags' shapes
 * (`layer.ts` yields the tags), and the workspace connection its own rows
 * and its one transaction are on.
 */
export interface AskNeeds {
    /** The workspace connection: the panel's tables, and the transaction that opens a conversation. */
    readonly db: DatabaseSync;
    readonly data: Pick<DataSpaceShape, 'detailFor'>;
    readonly schedules: Pick<SchedulesShape, 'find'>;
    /** The Board (issues). */
    readonly board: AskBoardShape;
    readonly pageMoves: PageMovesShape;
    readonly pages: Pick<PageStoreShape, 'get' | 'tree'>;
    readonly spaces: Pick<SpacesShape, 'readsSpace'>;
    readonly spaceAccess: Pick<SpaceAccessShape, 'reads'>;
    readonly socios: Pick<SociosShape, 'canUseDot' | 'dotsFor'>;
    readonly conversations: Pick<ConversationsShape, 'thread' | 'bindThread' | 'addChatPages'>;
}

export class AskError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 = 400,
    ) {
        super(message);
    }
}

/** What the panel's socio is told about the item, at most, per text field. */
const PAGE_TEXT_MAX = 20000;
const ISSUE_TEXT_MAX = 8000;
const PROMPT_TEXT_MAX = 4000;

const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}\n[… cut at ${max} characters]` : text;

/** An item the viewer may see now, with what the socio is shown of it. */
export interface ResolvedContext {
    context: AskContext;
    /** The page's Space: a socio needs access to it as well. */
    spaceId?: string;
    /** What the turn note shows the socio (untrusted data). */
    snapshot: Record<string, unknown> | null;
}

/** The stored id of an item: an issue's number, else the id as given. */
export function contextId(ref: AskContextRef): string {
    if (ref.kind === 'general') {
        return '';
    }
    if (ref.kind === 'issue') {
        const number = /^(?:CB-)?([1-9]\d{0,8})$/i.exec(ref.id.trim())?.[1];
        if (!number) {
            throw new AskError('Issue not found.', 404);
        }
        return number;
    }
    if (!ref.id || ref.id.length > 200) {
        throw new AskError('Not found.', 404);
    }
    return ref.id;
}

/**
 * The item `ref` names, read through the viewer's own access, as each
 * module's routes would show it to them; anything they can't see is
 * "not found", the same as an item that doesn't exist, so the answer
 * never tells them what exists. This is the panel's one scope check:
 * the routes call it before a thread is looked up or made, and the turn
 * note calls it again on every turn, with the thread's owner.
 */
export async function resolveContext(needs: AskNeeds, userId: string, ref: AskContextRef): Promise<ResolvedContext> {
    const id = contextId(ref);
    switch (ref.kind) {
        case 'general':
            return {
                context: { kind: 'general', id: '', title: null, path: null },
                snapshot: null,
            };
        case 'page': {
            const spaceId = await needs.pageMoves.locate(id);
            // A page in a Space they may not read is one that isn't there (CB-181).
            if (!spaceId || !needs.spaces.readsSpace(userId, spaceId)) {
                throw new AskError('Page not found.', 404);
            }
            let page;
            try {
                page = needs.pages.get(spaceId, id);
            } catch {
                throw new AskError('Page not found.', 404);
            }
            if (page.folder) {
                // A folder's body is hidden (CB-426): the socio is told its name and
                // what it holds, never the body, and the panel offers no page to ask about.
                return {
                    context: {
                        kind: 'page',
                        id,
                        title: page.title,
                        path: `/spaces/${spaceId}/pages/${id}`,
                        folder: true,
                    },
                    spaceId,
                    snapshot: { kind: 'folder', ...folderContext(page, needs.pages.tree(spaceId)) },
                };
            }
            return {
                context: {
                    kind: 'page',
                    id,
                    title: page.title,
                    path: `/spaces/${spaceId}/pages/${id}`,
                },
                spaceId,
                snapshot: {
                    kind: 'page',
                    id,
                    spaceId,
                    title: page.title,
                    revision: page.revision,
                    updatedAt: new Date(page.updatedAt).toISOString(),
                    content: clip(page.content, PAGE_TEXT_MAX),
                },
            };
        }
        case 'issue': {
            const issue = await needs.board.issues.get(Number(id));
            if (!issue) {
                throw new AskError('Issue not found.', 404);
            }
            const key = issueKey(issue.number);
            return {
                context: {
                    kind: 'issue',
                    id: key,
                    title: `${key}: ${issue.title}`,
                    path: `/issues/${key}`,
                },
                snapshot: {
                    kind: 'issue',
                    key,
                    title: issue.title,
                    status: issue.status,
                    priority: issue.priority,
                    type: issue.kind,
                    area: issue.area,
                    labels: issue.labels,
                    resolution: issue.resolution,
                    description: clip(issue.body, ISSUE_TEXT_MAX),
                },
            };
        }
        case 'dataset': {
            let detail;
            try {
                detail = needs.data.detailFor(userId, id);
            } catch {
                throw new AskError('Dataset not found.', 404);
            }
            const { dataset, tables } = detail;
            return {
                context: {
                    kind: 'dataset',
                    id,
                    title: dataset.name,
                    path: `/data/datasets/${encodeURIComponent(id)}`,
                },
                // Its shape, never its rows: the socio's own data tools decide
                // what it may read of them.
                snapshot: {
                    kind: 'dataset',
                    id,
                    name: dataset.name,
                    description: clip(dataset.description, PROMPT_TEXT_MAX),
                    access: dataset.access,
                    tables: tables.map((table) => ({
                        name: table.name,
                        rows: table.rowCount,
                        columns: table.columns.map((column) => column.name),
                    })),
                },
            };
        }
        case 'schedule': {
            const schedule = await needs.schedules.find(userId, id);
            if (!schedule) {
                throw new AskError('Schedule not found.', 404);
            }
            return {
                context: {
                    kind: 'schedule',
                    id,
                    title: schedule.title,
                    path: `/schedules/${encodeURIComponent(id)}`,
                },
                snapshot: {
                    kind: 'schedule',
                    id,
                    title: schedule.title,
                    type: schedule.kind,
                    prompt: clip(schedule.prompt, PROMPT_TEXT_MAX),
                    cadence: schedule.cadence,
                    timezone: schedule.timezone,
                    status: schedule.status,
                    socio: schedule.dotName,
                    job: schedule.jobName,
                    nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
                    lastRun: schedule.lastRun?.status ?? null,
                    error: schedule.error,
                },
            };
        }
    }
}
