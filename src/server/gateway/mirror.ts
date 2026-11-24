import { GitProxyError } from '../coding/contract.js';

import type { GitContext } from './git-context.js';
import { FLUSH, PktReader, pktLine, sideBandData } from './pkt.js';

/**
 * Refreshing `coding-git`'s mirror of a repository (CB-239), driven
 * by the app: a `contents: read` token for that one repository, GitHub's
 * refs, one upload-pack request for what the mirror lacks (its tips as
 * `have`s, never a thin pack), the pack streamed into `coding-git`, the
 * token revoked. `coding-git` holds no credential.
 * Each refresh counts against the instance's token ceiling.
 */

const SHA = /^[0-9a-f]{40}$/;
const MIRRORED = /^refs\/(heads|tags)\//;
const ADVERTISEMENT_LIMIT = 32 * 1024 * 1024;
const MAX_HAVES = 256;

async function readAll(response: Response, limit: number) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
            break;
        }
        size += chunk.value.length;
        if (size > limit) {
            await reader!.cancel();
            throw new GitProxyError(502, 'github_answer', 'GitHub’s answer was too large.');
        }
        chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
}

/** GitHub's upload-pack refs (v0): branches and tags, peeled entries skipped. */
export function parseUploadAdvertisement(body: Buffer) {
    const refs: Record<string, string> = {};
    let at = 0;
    while (at + 4 <= body.length) {
        const length = Number.parseInt(body.toString('ascii', at, at + 4), 16);
        if (!Number.isInteger(length) || (length > 0 && length < 4)) {
            break;
        }
        if (length === 0) {
            at += 4;
            continue;
        }
        const line = body
            .toString('utf8', at + 4, at + length)
            .replace(/\n$/, '')
            .split('\0')[0];
        at += length;
        const [sha, ref] = line.split(' ');
        if (SHA.test(sha ?? '') && ref && MIRRORED.test(ref) && !ref.endsWith('^{}')) {
            refs[ref] = sha;
        }
    }
    return refs;
}

/**
 * Brings the mirror up to GitHub's branches and tags, and `extraWants`
 * (commits an extraction names) when it lacks them. Throws
 * `GitProxyError` when coding-git or GitHub can't.
 */
export async function refreshMirror(
    context: GitContext,
    repository: string,
    extraWants: readonly string[] = [],
    signal?: AbortSignal,
    /** The session it is for, counted against its own mint cap. */
    session?: string,
) {
    const client = context.codingGit;
    if (!client) {
        throw new GitProxyError(
            503,
            'coding_git_unavailable',
            'Pushes and extractions need the coding-git service, which isn’t configured.',
        );
    }
    const { tips, has } = await client.refs(repository, extraWants[0]).catch(() => {
        throw new GitProxyError(503, 'coding_git_unavailable', 'coding-git could not be reached.');
    });
    const minted = await context.mint(repository, { contents: 'read' }, signal, session);
    try {
        const advertised = await minted.repo.smartHttp('/info/refs?service=git-upload-pack', { method: 'GET', signal });
        if (!advertised.ok) {
            await advertised.body?.cancel();
            throw new GitProxyError(502, 'github_refused', `GitHub refused the fetch (${advertised.status}).`);
        }
        const refs = parseUploadAdvertisement(await readAll(advertised, ADVERTISEMENT_LIMIT));
        const known = new Set(tips);
        const wants = [
            ...new Set([...Object.values(refs), ...(has ? [] : extraWants.filter((sha) => SHA.test(sha)))]),
        ].filter((sha) => !known.has(sha));
        if (!wants.length) {
            return await client.refresh(repository, refs, null);
        }
        const body = Buffer.concat([
            pktLine(`want ${wants[0]} side-band-64k ofs-delta no-progress agent=socio-gateway\n`),
            ...wants.slice(1).map((sha) => pktLine(`want ${sha}\n`)),
            FLUSH,
            ...tips.slice(0, MAX_HAVES).map((sha) => pktLine(`have ${sha}\n`)),
            pktLine('done\n'),
        ]);
        const response = await minted.repo.smartHttp('/git-upload-pack', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-git-upload-pack-request',
                Accept: 'application/x-git-upload-pack-result',
            },
            body,
            signal,
        });
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new GitProxyError(502, 'github_refused', `GitHub refused the fetch (${response.status}).`);
        }
        const reader = new PktReader(response.body.getReader());
        // ACK or NAK lines, then the side-band carrying the pack.
        let first: Awaited<ReturnType<PktReader['next']>>;
        for (;;) {
            first = await reader.next();
            if (first instanceof Buffer && /^(ACK|NAK)\b/.test(first.toString('ascii', 0, 3))) {
                continue;
            }
            break;
        }
        if (!(first instanceof Buffer) || ![1, 2, 3].includes(first[0])) {
            await reader.cancel();
            throw new GitProxyError(502, 'github_answer', 'GitHub’s fetch answer was not a pack.');
        }
        return await client.refresh(repository, refs, sideBandData(reader, first));
    } finally {
        await minted.revoke();
    }
}
