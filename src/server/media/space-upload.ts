// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { createHash } from 'node:crypto';

import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { pageImageMarkdown } from '@socio/shared/page-image';
import { formatSize } from '@socio/shared/text/format-size';

import type { ApprovalsShape } from '../approvals/contract.js';

import { MediaError, SPACE_UPLOAD_LIMITS } from './contract.js';
import type { MediaService, SpaceUploadView } from './service.js';

/**
 * `space_media_upload` (CB-524): a socio uploads files it may read (its
 * own data space folder, a folder granted to it, a file attached in this
 * conversation; its computer's files once copied there) into a Space's
 * media, for the person it acts for, so the Space's readers open them at
 * the URLs it returns. Reading a file is not leave to share it:
 *
 * - the socio must have the Space here (`socioReads`: everyone reading
 *   this chat may read it), and the person must be one of its editors;
 * - sharing new content waits on the person's approval, under their policy
 *   for this capability (manual, auto or bypass), bound to the exact files
 *   and their bytes, and used once;
 * - content already in the Space for that page is returned again without
 *   a second copy or a second approval: it is shared already.
 *
 * Each file gets its own result, so a partial import says what is missing.
 */
export const SPACE_MEDIA_TOOL_NAMES = ['space_media_upload'] as const;

/** What the tool files and reads approval requests through. */
export type SpaceUploadApprovals = Pick<ApprovalsShape, 'requestBound' | 'findPending' | 'consume'>;

/** One file of an approval request: what the person shares, by its bytes. */
interface PayloadFile {
    path: string;
    name: string;
    sha256: string;
    size: number;
    mediaType: string;
}

/** The request a Space upload waits on: what the card shows and the tool then stores. */
export interface SpaceUploadPayload {
    spaceId: string;
    pageId: string | null;
    files: PayloadFile[];
    /** The conversation it was asked in: an approval carries on there only. */
    threadId: string | null;
}

/** Registers the capability once, where media is built (`composition/media.ts`). */
export function registerSpaceUploadApprovals(approvals: Pick<ApprovalsShape, 'register'>) {
    approvals.register<SpaceUploadPayload>({
        capability: APPROVAL_CAPABILITIES.spaceMediaUpload,
        label: 'Share files in a Space',
        description:
            'A socio uploads images or PDFs it may read for you (its own files, folders you granted it, files you attached) into the media of a Space you edit, so everyone who reads that Space can open them.',
        consumable: true,
        auto: {
            maxRiskForAuto: 'low',
            riskNotes:
                'Copies files the socio may read for the person into a Space, where everyone who reads the Space can open them for as long as they read it. A file private to the person becomes visible to the Space.',
            describe: (payload) => ({
                spaceId: payload.spaceId,
                pageId: payload.pageId,
                files: payload.files.map(({ name, size, mediaType }) => ({ name, size, mediaType })),
            }),
        },
    });
}

const bindingOf = (turn: DotTurn, payload: SpaceUploadPayload) => ({
    bindingId: `media.space_upload:${turn.dot.id}:${turn.userId}:${turn.threadId ?? ''}`,
    digest: createHash('sha256')
        .update(
            JSON.stringify([
                payload.spaceId,
                payload.pageId,
                payload.files.map((file) => [file.path, file.sha256]),
                payload.threadId,
            ]),
        )
        .digest('hex'),
});

const samePayload = (a: SpaceUploadPayload, b: SpaceUploadPayload) =>
    a.spaceId === b.spaceId &&
    a.pageId === b.pageId &&
    a.threadId === b.threadId &&
    a.files.length === b.files.length &&
    a.files.every((file, index) => file.path === b.files[index]!.path && file.sha256 === b.files[index]!.sha256);

/** A file's display name: the one asked for, else the source's last part. */
const displayName = (path: string, name: string | undefined) =>
    (name?.trim() || path.split('/').filter(Boolean).pop() || 'file').slice(0, 200);

/** Square brackets and backslashes escaped, for a Markdown link's text. */
const linkText = (text: string) => text.replace(/[\\[\]]/g, (char) => `\\${char}`);

type Uploaded = SpaceUploadView;
type FileResult =
    | ({ path: string; ok: true; markdown: string } & Uploaded)
    | { path: string; ok: false; status: 'failed' | 'waiting_for_approval' | 'denied'; error: string };

const success = (path: string, uploaded: Uploaded, alt: string): FileResult => ({
    path,
    ok: true,
    ...uploaded,
    markdown:
        uploaded.kind === 'image'
            ? pageImageMarkdown({ id: uploaded.id, alt: alt.slice(0, 1000) })
            : `[${linkText(uploaded.name)}](${uploaded.url})`,
});

const failure = (path: string, error: string, status: 'failed' | 'waiting_for_approval' | 'denied' = 'failed') =>
    ({ path, ok: false, status, error }) satisfies FileResult;

/** A refusal of one file that the socio can act on; anything else is a fault. */
const refusal = (error: unknown) =>
    error instanceof MediaError || error instanceof DataError ? error.message : undefined;

/** The tool's options: the turn, media, and what it reads of the workspace through media's ports. */
export interface SpaceUploadOptions {
    media: MediaService;
    approvals: SpaceUploadApprovals;
    turn: DotTurn;
}

export function spaceUploadTools(options: SpaceUploadOptions): ToolDefinition[] {
    const limits = SPACE_UPLOAD_LIMITS;
    return [
        defineTool({
            name: 'space_media_upload',
            description: `Upload images and PDFs into a Space's media so everyone who can read that Space can open them, for example the assets of a Markdown or ZIP import. Sources are paths you can read with files_get: your own folder, a folder the person granted you, or a file attached in this conversation. A file on your computer must first be saved to your folder (computer_exec describes PUT $CB_DATA_URL/files). Allowed: PNG, JPEG, GIF and WebP images up to ${limits.imageMaxBytes / 1048576} MB and PDFs up to ${limits.pdfMaxBytes / 1048576} MB (or the data space's file limit if lower), recognized by their content, never by name or extension; at most ${limits.filesPerCall} files a call. The person you act for must be able to edit the Space. Sharing new files needs their consent: the tool may answer "pending_approval" and show them an approval card; never ask them to approve in your reply. When a note says they approved, call this tool again with exactly the same arguments: it then uploads, once. Uploading the same content again for the same Space and page returns the existing asset (reused: true), so retries are safe. Every file gets its own result: only those with ok: true were stored; report the others, and never call an import complete while any failed. Put each result's markdown in the page (an image block for images, a link for PDFs); never write a URL yourself. Uploads no page names are cleaned up after ${Math.round(limits.graceMs / 86_400_000)} days.`,
            parameters: z.object({
                spaceId: z.string().min(1).max(200).describe('The Space whose readers may open the files.'),
                pageId: z
                    .string()
                    .min(1)
                    .max(200)
                    .optional()
                    .describe('The page the files are for, in that Space. Omit for assets of the Space as a whole.'),
                files: z
                    .array(
                        z
                            .object({
                                path: z.string().min(1).max(512).describe('The source, as files_get takes it.'),
                                name: z
                                    .string()
                                    .max(200)
                                    .optional()
                                    .describe('The name readers see; the source file name by default.'),
                                alt: z
                                    .string()
                                    .max(1000)
                                    .optional()
                                    .describe('For an image: what it shows, for readers who cannot see it.'),
                            })
                            .strict(),
                    )
                    .min(1)
                    .max(limits.filesPerCall),
            }),
            execute: async (input) => {
                options.turn.check();
                return upload(options, input);
            },
        }),
    ];
}

async function upload(
    { media, approvals, turn }: SpaceUploadOptions,
    input: {
        spaceId: string;
        pageId?: string;
        files: Array<{ path: string; name?: string; alt?: string }>;
    },
) {
    const workspace = media.workspace;
    const { spaceId } = input;
    const pageId = input.pageId ?? null;
    // Sharing rights, checked before any file is read.
    if (!(workspace.socioReads?.(turn.threadId, spaceId, turn.dot.id) ?? false)) {
        return {
            error: 'Space access has been revoked or was not granted here. Nothing was uploaded.',
            code: 'space_not_available',
        };
    }
    if (!(workspace.editsSpace?.(turn.userId, spaceId) ?? false)) {
        return {
            error: 'The person you act for can’t edit this Space, so you can’t add to its media for them. Nothing was uploaded.',
            code: 'not_an_editor',
        };
    }
    if (pageId !== null && !(workspace.livePage?.(spaceId, pageId) ?? false)) {
        return { error: 'There is no such page in that Space. Nothing was uploaded.', code: 'page_not_found' };
    }

    // Each source, read as files_get reads it (the data space checks and
    // audits the socio's read), and checked by its bytes.
    const actor = { kind: 'dot' as const, userId: turn.userId, dotId: turn.dot.id, threadId: turn.threadId };
    const results = new Map<number, FileResult>();
    const pending: Array<{ index: number; bytes: Uint8Array; file: PayloadFile; alt: string }> = [];
    const seen = new Map<string, number>();
    for (const [index, asked] of input.files.entries()) {
        turn.check();
        const earlier = seen.get(asked.path);
        if (earlier !== undefined) {
            results.set(index, failure(asked.path, `The same file as item ${earlier + 1}; it is uploaded once.`));
            continue;
        }
        seen.set(asked.path, index);
        try {
            const { file, data } = await media.data.getFile(actor, asked.path);
            const checked = media.checkSpaceUpload(data);
            const name = displayName(file.path, asked.name);
            // Shared already: the same asset, without a copy or a card. Only
            // reused, never stored anew (its copy may be gone by now): new
            // content waits on the card below.
            const reused = await media.saveSpaceUpload(
                turn.userId,
                { spaceId, pageId, name, bytes: data, dotId: turn.dot.id },
                { reuseOnly: true },
            );
            if (reused) {
                results.set(index, success(asked.path, reused, asked.alt ?? name));
                continue;
            }
            pending.push({
                index,
                bytes: data,
                alt: asked.alt ?? name,
                file: {
                    path: file.path,
                    name,
                    sha256: checked.contentHash,
                    size: data.length,
                    mediaType: checked.mediaType,
                },
            });
        } catch (error) {
            const message = refusal(error);
            if (message === undefined) {
                throw error;
            }
            results.set(index, failure(asked.path, message));
        }
    }

    const answer = (extra: Record<string, unknown> = {}) => {
        const list = input.files.map((_, index) => results.get(index)!);
        const failed = list.filter((item) => !item.ok).length;
        return {
            spaceId,
            pageId,
            complete: failed === 0,
            uploaded: list.filter((item) => item.ok && !item.reused).length,
            reused: list.filter((item) => item.ok && item.reused).length,
            failed,
            results: list,
            ...extra,
        };
    };
    if (!pending.length) {
        return answer();
    }

    // New content: the person's consent, bound to these files and bytes.
    const payload: SpaceUploadPayload = {
        spaceId,
        pageId,
        files: pending.map((item) => item.file),
        threadId: turn.threadId ?? null,
    };
    const binding = bindingOf(turn, payload);
    const spaceName = workspace.spaceName?.(spaceId) ?? 'a Space';
    const outcome = await approvals.requestBound<SpaceUploadPayload>({
        userId: turn.userId,
        dotId: turn.dot.id,
        capability: APPROVAL_CAPABILITIES.spaceMediaUpload,
        summary: `Share ${pending.length} file${pending.length === 1 ? '' : 's'} with everyone who reads “${spaceName.slice(0, 80)}”`,
        // Two entries, so the card's detail limit (12) never drops a file:
        // what sharing means, then every file, one line each.
        details: [
            `Everyone who can read the Space can open these files, for as long as they can read it.${pageId ? ' They are for one page of it.' : ''}`,
            payload.files
                .map(
                    (file, index) =>
                        `${index + 1}. ${file.name.slice(0, 120)} (${file.mediaType === 'application/pdf' ? 'PDF' : 'image'}, ${formatSize(file.size)}) from ${file.path.slice(0, 200)}`,
                )
                .join('\n'),
        ],
        payload,
        threadId: turn.threadId,
        binding,
    });
    const waiting = (status: 'waiting_for_approval' | 'denied', message: string) => {
        for (const item of pending) {
            results.set(item.index, failure(item.file.path, message, status));
        }
    };
    if (outcome.status === 'denied') {
        waiting('denied', 'Not shared: the approval was denied.');
        return answer({ approval: outcome });
    }
    if (outcome.status === 'pending_approval') {
        waiting('waiting_for_approval', 'Waits on the person’s approval card.');
        return answer({
            approval: outcome,
            next: 'Once a note says they approved, call space_media_upload again with exactly these arguments: it uploads then, once.',
        });
    }
    if (outcome.status === 'bound' && !outcome.approved) {
        const card = await approvals.findPending<SpaceUploadPayload>(
            turn.userId,
            turn.dot.id,
            APPROVAL_CAPABILITIES.spaceMediaUpload,
            (other) => samePayload(other, payload),
        );
        waiting('waiting_for_approval', 'Already waits on its approval card. Do not retry.');
        return answer({
            approval:
                card?.id === outcome.id
                    ? card
                    : {
                          status: 'waiting_for_approval',
                          id: outcome.id,
                          message:
                              'These files already wait on their approval card. The decision comes back to you here.',
                      },
        });
    }
    const used = await approvals.consume(outcome.id, {
        capability: APPROVAL_CAPABILITIES.spaceMediaUpload,
        ...binding,
    });
    if (!used) {
        waiting(
            'denied',
            'That approval was already used. Call space_media_upload again: what was stored is returned, and new files show the person a new card.',
        );
        return answer();
    }
    // Approved: the rights again, as they are now, then each file.
    if (
        !(workspace.socioReads?.(turn.threadId, spaceId, turn.dot.id) ?? false) ||
        !(workspace.editsSpace?.(turn.userId, spaceId) ?? false) ||
        (pageId !== null && !(workspace.livePage?.(spaceId, pageId) ?? false))
    ) {
        waiting('denied', 'Access to the Space or page changed. Nothing was uploaded.');
        return answer();
    }
    for (const item of pending) {
        turn.check();
        try {
            const uploaded = await media.saveSpaceUpload(turn.userId, {
                spaceId,
                pageId,
                name: item.file.name,
                bytes: item.bytes,
                dotId: turn.dot.id,
            });
            results.set(item.index, success(item.file.path, uploaded, item.alt));
        } catch (error) {
            const message = refusal(error);
            if (message === undefined) {
                throw error;
            }
            results.set(item.index, failure(item.file.path, message));
        }
    }
    return answer();
}
