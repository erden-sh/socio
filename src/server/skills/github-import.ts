import { randomBytes, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';

import { z } from 'zod';

import {
    CHAT_SKILL_NAME,
    RESERVED_SKILL_NAMES,
    IMPORTED_SKILL_DESCRIPTION_MAX,
    IMPORTED_SKILL_INSTRUCTIONS_MAX,
    type SkillImportPreview,
} from '@socio/shared/chat/chat-skills';

import { isPublicAddress } from '../../net/public-address.js';

import type { WorkspaceSkillsRepository, WorkspaceSkill } from './contract.js';

const SHA = /^[a-f0-9]{40}$/;
const FILE_MAX = 128 * 1024;
const LICENSE_MAX = 32 * 1024;
const RESPONSE_MAX = 512 * 1024;
const TOTAL_MAX = 2 * 1024 * 1024;
const TIMEOUT = 10_000;
const PREVIEW_TTL = 10 * 60_000;
const PREVIEWS_MAX = 20;
const PATH_PART = /^[A-Za-z0-9_. -]+$/;

export const importSourceSchema = z
    .object({
        url: z.string().max(200),
        ref: z.string().min(1).max(200),
        path: z.string().min(1).max(500),
    })
    .strict();
export const importApplySchema = z
    .object({
        previewId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();

/** Public GitHub repositories only. Never turn input into an arbitrary URL. */
export function githubSource(input: z.infer<typeof importSourceSchema>) {
    const parsed = importSourceSchema.parse(input);
    const repo = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/.exec(
        parsed.url,
    );
    if (!repo || ['.', '..'].includes(repo[2])) {
        throw Error(
            'Use a public https://github.com/owner/repository URL, without credentials, query, fragment or trailing path.',
        );
    }
    if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(parsed.ref) ||
        parsed.ref.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
        throw Error("Choose a branch, tag or full commit without empty, '.' or '..' path segments.");
    }
    const parts = parsed.path.split('/');
    if (
        parts.length > 12 ||
        parts.at(-1) !== 'SKILL.md' ||
        parts.some((part) => !PATH_PART.test(part) || part === '.' || part === '..' || part.trim() !== part)
    ) {
        throw Error(
            'Choose a repository-relative SKILL.md path, at most 12 segments, without traversal or encoded separators.',
        );
    }
    return { ...parsed, owner: repo[1], repository: repo[2], parts };
}

/** A small scalar-only frontmatter subset: strings and folded/literal text.
 * Complex YAML, aliases and executable tags are rejected, never evaluated. */
export function parseSkillDocument(text: string) {
    if (text.includes('\0')) {
        throw Error('The skill must be UTF-8 text without NUL characters.');
    }
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!header || header[1].length > 8192) {
        throw Error('The skill needs bounded YAML frontmatter with name and description.');
    }
    const fields: Record<string, string> = Object.create(null);
    const lines = header[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith('#')) {
            continue;
        }
        const entry = /^([a-zA-Z][a-zA-Z0-9_-]*):[ \t]*(.*)$/.exec(line);
        if (!entry || Object.hasOwn(fields, entry[1])) {
            throw Error('Frontmatter must contain unique scalar fields; nested YAML and aliases are not supported.');
        }
        let value = entry[2];
        if (/^[>|][-+]?$/.test(value)) {
            const block: string[] = [];
            while (index + 1 < lines.length && (!lines[index + 1].trim() || /^\s/.test(lines[index + 1]))) {
                block.push(lines[++index]);
            }
            const indent = Math.min(...block.filter((item) => item.trim()).map((item) => /^\s*/.exec(item)![0].length));
            const body = block.map((item) => item.slice(Number.isFinite(indent) ? indent : 0));
            value = value[0] === '>' ? body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : body.join('\n');
            value = value.trimEnd();
        } else if (value.startsWith('"')) {
            try {
                value = JSON.parse(value) as string;
            } catch {
                throw Error('Use plain, JSON-quoted, single-quoted or block text frontmatter strings.');
            }
            if (typeof value !== 'string') {
                throw Error('Frontmatter values must be strings.');
            }
        } else if (value.startsWith("'")) {
            if (!/^'(?:[^']|'')*'$/.test(value)) {
                throw Error('Invalid single-quoted frontmatter string.');
            }
            value = value.slice(1, -1).replace(/''/g, "'");
        } else {
            if (/^[!&*[{]/.test(value) || /:\s/.test(value)) {
                throw Error('Complex YAML values, tags and aliases are not supported.');
            }
            value = value.replace(/\s+#.*$/, '').trim();
        }
        fields[entry[1]] = value;
    }
    if (!CHAT_SKILL_NAME.test(fields.name ?? '') || RESERVED_SKILL_NAMES.includes(fields.name)) {
        throw Error('The source skill name is invalid or reserved; built-in skills cannot be replaced.');
    }
    if (!fields.description?.trim() || fields.description.length > IMPORTED_SKILL_DESCRIPTION_MAX) {
        throw Error(`Imported descriptions must contain 1–${IMPORTED_SKILL_DESCRIPTION_MAX} characters.`);
    }
    const instructions = text.slice(header[0].length);
    if (!instructions.trim() || instructions.length > IMPORTED_SKILL_INSTRUCTIONS_MAX) {
        throw Error(
            `Imported instructions must contain 1–${IMPORTED_SKILL_INSTRUCTIONS_MAX} characters; nothing is truncated.`,
        );
    }
    return {
        name: fields.name,
        description: fields.description,
        instructions,
        license: fields.license,
        ignored: Object.keys(fields).filter((key) => !['name', 'description', 'license'].includes(key)),
    };
}

type ReadJson = (url: URL, maxBytes: number, signal: AbortSignal) => Promise<{ value: unknown; bytes: number }>;

/** No tokens, redirects or arbitrary hosts; pin the connection to public DNS. */
export const readGitHubSkillJson: ReadJson = async (url, maxBytes, signal) => {
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password) {
        throw Error('Only the public GitHub API is allowed.');
    }
    signal.throwIfAborted();
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        void lookup(url.hostname, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted));
    });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
        throw Error('GitHub must resolve only to public network addresses.');
    }
    const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: true });
    return new Promise<{ value: unknown; bytes: number }>((resolve, reject) => {
        const request = https.get(
            url,
            {
                signal,
                agent,
                rejectUnauthorized: true,
                headers: {
                    Accept: 'application/vnd.github+json',
                    'Accept-Encoding': 'identity',
                    'User-Agent': 'Socio-public-skill-import',
                },
                lookup: (_host, options, callback) =>
                    options.all
                        ? callback(null, [addresses[0]])
                        : callback(null, addresses[0].address, addresses[0].family),
            },
            (response) => {
                if (
                    response.statusCode !== 200 ||
                    (response.headers['content-encoding'] ?? 'identity') !== 'identity' ||
                    !/^application\/json\b/i.test(String(response.headers['content-type']))
                ) {
                    response.destroy();
                    reject(
                        Error(
                            `GitHub replied ${response.statusCode ?? 'without a status'}; redirects, compressed content and non-JSON responses are not accepted.`,
                        ),
                    );
                    return;
                }
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > maxBytes) {
                        response.destroy(Error('The GitHub response exceeds the import size limit.'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        resolve({
                            value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                            bytes,
                        });
                    } catch {
                        reject(Error('GitHub did not return valid JSON.'));
                    }
                });
            },
        );
        request.on('error', reject);
    }).finally(() => agent.destroy());
};

const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const decodeBlob = (value: unknown, max: number, expectedSha: string) => {
    const blob = z
        .object({
            encoding: z.literal('base64'),
            size: z.number().int().nonnegative().max(max),
            content: z.string().max(Math.ceil(max / 3) * 4 + max / 20 + 100),
        })
        .parse(value);
    const encoded = blob.content.replace(/\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw Error('The GitHub blob is not valid base64.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== blob.size || bytes.length > max) {
        throw Error('The GitHub blob size does not match its content.');
    }
    const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (object(value).sha !== expectedSha || digest !== expectedSha) {
        throw Error('The downloaded Git blob does not match its pinned tree hash.');
    }
    return bytes;
};

export class GitHubSkillImporter {
    private pending = 0;
    private previews = new Map<
        string,
        {
            actor: string;
            preview: SkillImportPreview;
            expected: Pick<WorkspaceSkill, 'id' | 'revision' | 'sha256'> | null;
        }
    >();
    constructor(
        private repository: WorkspaceSkillsRepository,
        private options: { read?: ReadJson; now?: () => number } = {},
    ) {}
    private now() {
        return (this.options.now ?? Date.now)();
    }
    async preview(actor: string, input: z.infer<typeof importSourceSchema>): Promise<SkillImportPreview> {
        if (this.pending >= 2) {
            throw Error('Two skill imports are already being previewed. Try again shortly.');
        }
        this.pending++;
        try {
            return await this.prepare(actor, input);
        } finally {
            this.pending--;
        }
    }
    private async prepare(actor: string, input: z.infer<typeof importSourceSchema>): Promise<SkillImportPreview> {
        const source = githubSource(input),
            signal = AbortSignal.timeout(TIMEOUT);
        let total = 0,
            calls = 0;
        const get = async (path: string) => {
            signal.throwIfAborted();
            if (++calls > 18) {
                throw Error('The repository path needs too many requests.');
            }
            if (total >= TOTAL_MAX) {
                throw Error('The repository response exceeds the bounded import budget.');
            }
            const response = await (this.options.read ?? readGitHubSkillJson)(
                new URL(`https://api.github.com/repos/${source.owner}/${source.repository}/${path}`),
                Math.min(RESPONSE_MAX, TOTAL_MAX - total),
                signal,
            );
            total += response.bytes;
            if (response.bytes > RESPONSE_MAX || total > TOTAL_MAX) {
                throw Error('The repository response exceeds the bounded import budget.');
            }
            return object(response.value);
        };
        const commitInfo = await get(`commits/${encodeURIComponent(source.ref)}`);
        const commit = z.string().regex(SHA).parse(commitInfo.sha);
        if (/^[a-fA-F0-9]{40}$/.test(source.ref) && commit !== source.ref.toLowerCase()) {
            throw Error('GitHub returned a different commit than the explicitly pinned source.');
        }
        const rootSha = z
            .string()
            .regex(SHA)
            .parse(object(object(commitInfo.commit).tree).sha);
        type Entry = {
            path: string;
            mode: string;
            type: string;
            sha: string;
            size?: number;
        };
        const entries = async (sha: string): Promise<Entry[]> => {
            const tree = await get(`git/trees/${sha}`);
            if (tree.sha !== sha) {
                throw Error('GitHub returned a different tree than the pinned commit requested.');
            }
            if (tree.truncated !== false) {
                throw Error('The GitHub tree is incomplete; choose a smaller repository.');
            }
            return z
                .array(
                    z.object({
                        path: z.string(),
                        mode: z.string(),
                        type: z.string(),
                        sha: z.string().regex(SHA),
                        size: z.number().optional(),
                    }),
                )
                .max(4000)
                .parse(tree.tree);
        };
        const root = await entries(rootSha);
        let tree = root,
            file: Entry | undefined;
        for (let index = 0; index < source.parts.length; index++) {
            const entry = tree.find((item) => item.path === source.parts[index]);
            if (!entry) {
                throw Error('The requested SKILL.md path does not exist at that commit.');
            }
            if (index < source.parts.length - 1) {
                if (entry.type !== 'tree' || entry.mode !== '040000') {
                    throw Error('Skill paths must use ordinary directories, never symlinks or git submodules.');
                }
                tree = await entries(entry.sha);
            } else {
                if (entry.type !== 'blob' || entry.mode !== '100644') {
                    throw Error('SKILL.md must be an ordinary non-executable file, never a symlink or submodule.');
                }
                if (!Number.isInteger(entry.size) || entry.size! > FILE_MAX) {
                    throw Error('SKILL.md exceeds the import file size limit.');
                }
                file = entry;
            }
        }
        const bytes = decodeBlob(await get(`git/blobs/${file!.sha}`), FILE_MAX, file!.sha);
        if (bytes.length !== file!.size) {
            throw Error('The downloaded file does not match the tree size.');
        }
        const parsed = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const licenseFile = root.find((entry) => /^(LICENSE|LICENCE)(\.md|\.txt)?$/i.test(entry.path));
        let licenseText = '';
        if (licenseFile) {
            if (
                licenseFile.type !== 'blob' ||
                licenseFile.mode !== '100644' ||
                !Number.isInteger(licenseFile.size) ||
                licenseFile.size! > LICENSE_MAX
            ) {
                throw Error('The repository license must be a bounded regular text file.');
            }
            licenseText = new TextDecoder('utf-8', { fatal: true }).decode(
                decodeBlob(await get(`git/blobs/${licenseFile.sha}`), LICENSE_MAX, licenseFile.sha),
            );
        }
        const previous = await this.repository.get(parsed.name);
        const preview: SkillImportPreview = {
            id: randomBytes(24).toString('base64url'),
            expiresAt: this.now() + PREVIEW_TTL,
            name: parsed.name,
            description: parsed.description,
            instructions: parsed.instructions,
            mode: previous?.mode ?? 'turn',
            source: {
                url: source.url,
                ref: source.ref,
                path: source.path,
                commit,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                license: parsed.license
                    ? `Source declares: ${parsed.license}`
                    : licenseText
                      ? 'Repository license (review text)'
                      : 'Not provided',
                licenseText,
            },
            previous: previous
                ? {
                      revision: previous.revision,
                      instructions: previous.instructions,
                      description: previous.description,
                  }
                : null,
            warnings: [
                'Only SKILL.md text is imported. No scripts, dependencies, tool permissions or referenced files are installed or executed.',
                ...(licenseText || parsed.license
                    ? []
                    : ['The repository did not provide a root license; review reuse terms before applying.']),
                ...(parsed.ignored.length
                    ? [
                          `Metadata is informational only and does not grant tools or execution: ${parsed.ignored.join(', ')}.`,
                      ]
                    : []),
            ],
        };
        for (const [key, entry] of this.previews) {
            if (entry.preview.expiresAt <= this.now()) {
                this.previews.delete(key);
            }
        }
        while (this.previews.size >= PREVIEWS_MAX) {
            this.previews.delete(this.previews.keys().next().value!);
        }
        this.previews.set(preview.id, {
            actor,
            preview: structuredClone(preview),
            expected: previous
                ? {
                      id: previous.id,
                      revision: previous.revision,
                      sha256: previous.sha256,
                  }
                : null,
        });
        return preview;
    }
    async apply(actor: string, input: z.infer<typeof importApplySchema>) {
        const { previewId, sha256 } = importApplySchema.parse(input);
        const entry = this.previews.get(previewId);
        if (
            !entry ||
            entry.actor !== actor ||
            entry.preview.expiresAt <= this.now() ||
            entry.preview.source.sha256 !== sha256
        ) {
            throw Error('This import preview is unavailable, expired or changed. Preview the source again.');
        }
        const { preview } = entry;
        const result = await this.repository.import(
            {
                name: preview.name,
                description: preview.description,
                instructions: preview.instructions,
                mode: preview.mode,
            },
            { ...preview.source },
            entry.expected,
            actor,
        );
        this.previews.delete(previewId);
        return result;
    }
}

const importers = new WeakMap<WorkspaceSkillsRepository, GitHubSkillImporter>();
export function skillImporter(repository: WorkspaceSkillsRepository) {
    let importer = importers.get(repository);
    if (!importer) {
        importer = new GitHubSkillImporter(repository);
        importers.set(repository, importer);
    }
    return importer;
}
