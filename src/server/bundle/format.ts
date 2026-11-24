/**
 * A workspace bundle on disk (CB-380): a directory, private to the server's
 * user (0700, files 0600), holding
 *
 *   manifest.json   what it is: format, source, schema versions, the
 *                   selection, counts, and the sha256 of every other file;
 *   users.json      the people and socios its records name (id, display
 *                   name, email for people): for author mapping only;
 *   spaces.jsonl    one Space per line;
 *   pages.jsonl     one page per line, parents before children;
 *   issues.jsonl    one issue per line, with its comments, attachments,
 *                   votes, history and links;
 *   files/<sha256>  attachment and image bytes, unsealed, named by hash.
 *
 * The importer treats all of it as untrusted input: every line is parsed
 * with the schemas below, and every file's hash is checked before use.
 */
import { z } from 'zod';

export const BUNDLE_FORMAT = 'socio-workspace-bundle';
export const BUNDLE_FORMAT_VERSION = 1;

/** The data files of a bundle, in the order they are written and read. */
export const BUNDLE_FILES = ['users.json', 'spaces.jsonl', 'pages.jsonl', 'issues.jsonl'] as const;
export type BundleFileName = (typeof BUNDLE_FILES)[number];

/**
 * The schema modules whose tables a bundle reads and writes: an import
 * refuses a bundle whose versions of these differ from the target's.
 */
export const BUNDLE_SCHEMA_MODULES = ['issues', 'pages', 'workspace', 'spaces', 'media', 'data'] as const;

const id = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const time = z.number().int().nonnegative();
const optionalTime = time.nullable();
const text = (max: number) => z.string().max(max);

export const manifestSchema = z
    .object({
        format: z.literal(BUNDLE_FORMAT),
        formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
        createdAt: time,
        appVersion: text(64),
        source: z
            .object({
                /** The source's APP_ORIGIN, as https://host (no path, no trailing slash). */
                origin: z
                    .string()
                    .url()
                    .regex(/^https?:\/\/[^/?#]+$/),
                /** How the target names the source in bylines and links ("Acme"). */
                label: z
                    .string()
                    .min(1)
                    .max(40)
                    .regex(/^[\p{L}\p{N} ._-]+$/u),
                /** The source's issue key prefix ("CB"). */
                issuePrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
            })
            .strict(),
        schema: z.record(z.string(), z.number().int().nonnegative()),
        selection: z
            .object({
                issues: z.array(z.number().int().positive()),
                spaces: z.array(id),
                pages: z.array(id),
            })
            .strict(),
        counts: z.record(z.string(), z.number().int().nonnegative()),
        /** sha256 and size of each data file. */
        files: z.record(z.string(), z.object({ sha256, bytes: z.number().int().nonnegative() }).strict()),
        /** Every blob under files/, by sha256, with its size. */
        blobs: z.record(sha256, z.number().int().nonnegative()),
    })
    .strict();
export type BundleManifest = z.infer<typeof manifestSchema>;

export const userRecordSchema = z
    .object({
        id,
        name: text(200),
        email: z.string().max(320).nullable(),
        kind: z.enum(['person', 'socio']),
    })
    .strict();
export type UserRecord = z.infer<typeof userRecordSchema>;
export const usersFileSchema = z.array(userRecordSchema);

export const spaceRecordSchema = z
    .object({
        id,
        name: text(200),
        description: text(200_000),
        createdAt: time,
        membersOnly: z.boolean(),
        members: z.array(z.object({ userId: id, role: z.enum(['editor', 'member']), addedAt: time }).strict()),
        /** The whole Space was selected (not only some of its pages). */
        whole: z.boolean(),
    })
    .strict();
export type SpaceRecord = z.infer<typeof spaceRecordSchema>;

export const imageRecordSchema = z
    .object({
        embedId: id,
        sha256,
        size: z.number().int().nonnegative(),
        mediaType: text(200),
        name: text(300),
        sourceUrl: text(4096),
        createdAt: time,
    })
    .strict();
export type ImageRecord = z.infer<typeof imageRecordSchema>;

export const pageRecordSchema = z
    .object({
        id,
        spaceId: id,
        /** Null when the parent isn't in the bundle: the page is a root there. */
        parentId: id.nullable(),
        title: z.string().min(1).max(160),
        content: text(100_000),
        createdAt: time,
        updatedAt: time,
        createdBy: id.nullable(),
        coverId: id.nullable(),
        sourceUrl: text(2048).nullable(),
        sourceTitle: text(300).nullable(),
        tags: z.array(
            z.object({ tag: z.string().min(1).max(100), createdBy: id.nullable(), createdAt: time }).strict(),
        ),
        links: z.array(
            z
                .object({
                    id,
                    toPageId: id,
                    kind: z.enum(['index', 'derived_from', 'cites', 'related']),
                    createdBy: id.nullable(),
                    createdAt: time,
                })
                .strict(),
        ),
        images: z.array(imageRecordSchema),
    })
    .strict();
export type PageRecord = z.infer<typeof pageRecordSchema>;

const STATUS = z.enum(['triage', 'open', 'ready', 'in_progress', 'in_review', 'blocked', 'done', 'wont_fix']);

export const issueRecordSchema = z
    .object({
        id,
        number: z.number().int().positive().max(999_999_999),
        title: z.string().min(1).max(500),
        body: text(200_000),
        status: STATUS,
        priority: z.enum(['critical', 'high', 'medium', 'low']),
        kind: z.enum(['bug', 'feature', 'improvement', 'docs', 'chore', 'request']),
        area: text(200).nullable(),
        reporterId: id,
        assigneeId: id.nullable(),
        resolution: text(200_000).nullable(),
        createdAt: time,
        updatedAt: time,
        closedAt: optionalTime,
        labels: z.array(z.string().min(1).max(100)),
        comments: z.array(
            z
                .object({
                    id,
                    authorKind: z.enum(['user', 'agent', 'system']),
                    authorId: id.nullable(),
                    body: text(200_000),
                    createdAt: time,
                    editedAt: optionalTime,
                })
                .strict(),
        ),
        attachments: z.array(
            z
                .object({
                    id,
                    commentId: id.nullable(),
                    name: text(300),
                    mediaType: text(200),
                    size: z.number().int().nonnegative(),
                    sha256,
                    uploaderId: id,
                    createdAt: time,
                })
                .strict(),
        ),
        votes: z.array(z.object({ id, userId: id, createdAt: time }).strict()),
        events: z.array(
            z
                .object({
                    id,
                    actorId: id.nullable(),
                    kind: z.string().min(1).max(64),
                    // History keeps whole field values (an edited description, before and after).
                    fromValue: text(200_000).nullable(),
                    toValue: text(200_000).nullable(),
                    createdAt: time,
                })
                .strict(),
        ),
        /** Live blocked-by and related links that touch this issue, either end. */
        links: z.array(
            z
                .object({
                    id,
                    kind: z.enum(['blocked_by', 'related']),
                    fromId: id,
                    fromNumber: z.number().int().positive(),
                    toId: id,
                    toNumber: z.number().int().positive(),
                    createdBy: id,
                    createdAt: time,
                })
                .strict(),
        ),
    })
    .strict();
export type IssueRecord = z.infer<typeof issueRecordSchema>;
