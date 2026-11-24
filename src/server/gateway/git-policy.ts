import { validCodingRepository } from '@socio/shared/coding/coding-repos';

import { FLUSH, pktLine, sideBand } from './pkt.js';

/**
 * The Git proxy's request policy (CB-239):
 * which paths exist, what a push may ask for, and which capabilities are
 * relayed. Pure; `git.ts` applies it before anything reaches GitHub, and
 * `coding-git` then inspects what the push would add.
 */

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitRoutePath {
    repository: string;
    kind: 'advertise' | 'rpc';
    service: GitService;
}

const PATH = /^\/git\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * A Git route's repository and service, or undefined for anything else
 * (a 404): only the three smart-HTTP endpoints, a strict `owner/name`
 * with no `..`, and for `info/refs` only the two services.
 */
export function parseGitPath(method: string, path: string, query: URLSearchParams): GitRoutePath | undefined {
    const match = PATH.exec(path);
    if (!match || !validCodingRepository(match[1])) {
        return undefined;
    }
    const [, repository, endpoint] = match;
    if (endpoint === 'info/refs') {
        const service = query.get('service');
        if (
            method !== 'GET' ||
            (service !== 'git-upload-pack' && service !== 'git-receive-pack') ||
            [...query.keys()].some((key) => key !== 'service')
        ) {
            return undefined;
        }
        return { repository, kind: 'advertise', service };
    }
    if (method !== 'POST' || [...query.keys()].length) {
        return undefined;
    }
    return { repository, kind: 'rpc', service: endpoint as GitService };
}

/** Whether a path is one of the Git routes at all (the route's `match`). */
export const isGitPath = (path: string) => path.startsWith('/git/');

/**
 * What a push may ask of the receiving side: no push options, no
 * push certificates, no deletes; the rest of the advertisement is dropped
 * before it is relayed, so a client never offers more.
 */
export const PUSH_CAPABILITIES = ['report-status', 'side-band-64k', 'atomic', 'quiet', 'ofs-delta'] as const;

const capabilityAllowed = (capability: string) =>
    (PUSH_CAPABILITIES as readonly string[]).includes(capability) || /^agent=[\x21-\x7e]{1,100}$/.test(capability);

/**
 * The receive-pack advertisement the proxy serves itself: GitHub's
 * branches and tags, read with a `contents: read` token, and only the
 * allowed capabilities, so no write token exists before a push is checked
 * and a client never offers push options or certificates.
 */
export function receiveAdvertisement(refs: Record<string, string>) {
    const caps = [...PUSH_CAPABILITIES, 'agent=socio-gateway'].join(' ');
    const entries = Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1));
    const lines = entries.length
        ? entries.map(([ref, sha], index) => pktLine(index === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`))
        : [pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`)];
    return Buffer.concat([pktLine('# service=git-receive-pack\n'), FLUSH, ...lines, FLUSH]);
}

const SHA = /^[0-9a-f]{40}$/;
export const ZERO_SHA = '0'.repeat(40);

export interface ReceiveCommand {
    old: string;
    new: string;
    ref: string;
}

/** Why a push is refused before anything is forwarded. */
export type RefRefusal = 'ref_outside_session' | 'ref_delete' | 'capability_refused' | 'commands_malformed';

export type CommandCheck =
    | { ok: true; commands: ReceiveCommand[]; capabilities: string[] }
    | { ok: false; reason: RefRefusal; detail: string };

/**
 * A push's commands (`old new ref`, the first with its capabilities)
 * checked against the session's branch: exactly one command, naming
 * exactly `refs/heads/<branch>`, a create or an update, never a delete, a
 * tag or another namespace; and only allowed capabilities, so no push
 * options or certificates.
 */
export function checkPushCommands(lines: readonly string[], branch: string): CommandCheck {
    const ref = `refs/heads/${branch}`;
    if (!lines.length) {
        return { ok: false, reason: 'commands_malformed', detail: 'no commands' };
    }
    const commands: ReceiveCommand[] = [];
    let capabilities: string[] = [];
    for (const [index, raw] of lines.entries()) {
        const line = raw.replace(/\n$/, '');
        if (index === 0 && line.startsWith('push-cert')) {
            return {
                ok: false,
                reason: 'capability_refused',
                detail: 'signed pushes are not accepted',
            };
        }
        const nul = line.indexOf('\0');
        const command = nul >= 0 ? line.slice(0, nul) : line;
        if (nul >= 0) {
            if (index !== 0) {
                return {
                    ok: false,
                    reason: 'commands_malformed',
                    detail: 'capabilities after the first command',
                };
            }
            capabilities = line
                .slice(nul + 1)
                .split(' ')
                .filter(Boolean);
        }
        const [old, next, name, ...extra] = command.split(' ');
        if (!SHA.test(old ?? '') || !SHA.test(next ?? '') || !name || extra.length) {
            return {
                ok: false,
                reason: 'commands_malformed',
                detail: 'a command is not "old new ref"',
            };
        }
        commands.push({ old, new: next, ref: name });
    }
    const refused = capabilities.find((cap) => !capabilityAllowed(cap));
    if (refused) {
        return {
            ok: false,
            reason: 'capability_refused',
            detail: `the capability ${refused.slice(0, 40)} is not accepted`,
        };
    }
    if (commands.length !== 1 || commands[0].ref !== ref) {
        return {
            ok: false,
            reason: 'ref_outside_session',
            detail: `only ${ref} may be pushed`,
        };
    }
    if (commands[0].new === ZERO_SHA) {
        return {
            ok: false,
            reason: 'ref_delete',
            detail: 'branches can’t be deleted',
        };
    }
    return { ok: true, commands, capabilities };
}

/**
 * A receive-pack result refusing the push, as `report-status` says it
 * (wrapped in side-band 1 when the client asked for it), so `git push`
 * prints why. Text is plain ASCII, one line.
 */
export function refusalReport(refs: readonly string[], message: string, capabilities: readonly string[]) {
    const clean = message.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
    const report = Buffer.concat([
        pktLine('unpack ok\n'),
        ...(refs.length ? refs : ['refs/heads/unknown']).map((ref) =>
            pktLine(`ng ${ref.replace(/[^\x21-\x7e]/g, '?')} refused by Socio: ${clean}\n`),
        ),
        FLUSH,
    ]);
    if (!capabilities.includes('side-band-64k')) {
        return report;
    }
    return Buffer.concat([sideBand(1, report), FLUSH]);
}
