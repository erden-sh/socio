import { framed } from '../../coding-git/frame.js';
import type { PushRefusal } from '../../coding-git/rules.js';
import { codingGitKey } from '../../coding-git/server.js';
import type { ExtractRequest, ExtractResult, InspectMeta, InspectVerdict } from '../../coding-git/service.js';

/**
 * The app's client of `coding-git` (CB-239, CB-267): mirror refs and
 * refreshes, push inspection with the pack streamed through (the app
 * keeps no copy), the accepted pack read back, and
 * extractions. `CODING_GIT_URL` and `CODING_GIT_SECRET`; without them
 * pushes and extractions are refused (fail closed) and fetches still work.
 */

export interface CodingGitSettings {
    url: string;
    secret: string;
}

export function codingGitSettingsFromEnv(env: Record<string, string | undefined>): CodingGitSettings | undefined {
    const url = env.CODING_GIT_URL?.trim();
    const secret = env.CODING_GIT_SECRET?.trim();
    if (!url || !secret) {
        return undefined;
    }
    if (secret.length < 24) {
        throw new Error('CODING_GIT_SECRET must be 24+ characters.');
    }
    if (!/^https?:\/\/[^/]+\/?$/.test(url)) {
        throw new Error('CODING_GIT_URL must be an http(s) origin.');
    }
    return { url: url.replace(/\/$/, ''), secret };
}

export class CodingGitUnavailable extends Error {}

/**
 * The refusals coding-git may answer, each with the one text Socio shows
 * for it: its reason goes into the audit's closed list and its text to the
 * sandbox's `git push`, so neither is taken from coding-git, which parses
 * hostile packs. Any other answer
 * counts as coding-git unavailable.
 */
const PUSH_REFUSALS: Record<PushRefusal | 'mirror_missing', string> = {
    protected_path: '.github/ and CODEOWNERS are a person’s to change',
    submodule: 'submodules (.gitmodules, gitlinks) are not accepted',
    token_shape: 'the push holds something shaped like a Socio token',
    foreign_identity: 'commits must be authored and committed as the socio',
    commit_text:
        'a commit message holds an email address, a trailer naming someone else, a closing keyword, a CI skip directive or a non-UTF-8 encoding',
    not_a_commit: 'a pushed ref is not a commit',
    too_many_commits: 'the push adds too many commits',
    pack_invalid: 'the push is not a valid Git pack',
    pack_too_large: 'the push is larger than allowed',
    mirror_missing: 'the repository has no mirror yet',
};
const EXTRACT_FAILURES: Record<Extract<ExtractResult, { ok: false }>['reason'], string> = {
    commit_missing: 'the commit is not in the mirror',
    too_large: 'the paths hold more than the extraction limit',
    paths_invalid: 'the paths are not a valid scope',
};
const SHA = /^[0-9a-f]{40}$/;
const SPOOL = /^[0-9a-f-]{36}$/;

const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CodingGitUnavailable('coding-git’s answer was malformed.');
    }
    return value as Record<string, unknown>;
};
const known = <T extends string>(map: Record<T, string>, reason: unknown) =>
    typeof reason === 'string' && Object.hasOwn(map, reason) ? (reason as T) : undefined;

/** A push verdict as Socio uses it, or `CodingGitUnavailable`. */
export function checkedVerdict(answer: unknown): InspectVerdict {
    const verdict = record(answer);
    if (verdict.ok === true) {
        if (
            typeof verdict.spool !== 'string' ||
            !SPOOL.test(verdict.spool) ||
            !Number.isSafeInteger(verdict.commits) ||
            (verdict.commits as number) < 0
        ) {
            throw new CodingGitUnavailable('coding-git’s verdict was malformed.');
        }
        return {
            ok: true,
            spool: verdict.spool,
            commits: verdict.commits as number,
        };
    }
    const reason = verdict.ok === false && known(PUSH_REFUSALS, verdict.reason);
    if (!reason) {
        throw new CodingGitUnavailable('coding-git’s verdict was malformed.');
    }
    return { ok: false, reason, detail: PUSH_REFUSALS[reason] };
}

/** An extraction's result as Socio uses it, or `CodingGitUnavailable`. */
export function checkedExtraction(answer: unknown): ExtractResult {
    const result = record(answer);
    if (result.ok === true) {
        const files = result.files;
        if (
            !Array.isArray(files) ||
            !Number.isSafeInteger(result.bytes) ||
            !Number.isSafeInteger(result.dropped) ||
            !files.every((file) => {
                const entry = file as Record<string, unknown> | null;
                return (
                    !!entry &&
                    typeof entry.path === 'string' &&
                    typeof entry.executable === 'boolean' &&
                    Number.isSafeInteger(entry.size) &&
                    typeof entry.content === 'string'
                );
            })
        ) {
            throw new CodingGitUnavailable('coding-git’s files were malformed.');
        }
        return result as Extract<ExtractResult, { ok: true }>;
    }
    const reason = result.ok === false && known(EXTRACT_FAILURES, result.reason);
    if (!reason) {
        throw new CodingGitUnavailable('coding-git’s answer was malformed.');
    }
    return { ok: false, reason, detail: EXTRACT_FAILURES[reason] };
}

export class CodingGitClient {
    private key: string;
    constructor(
        private settings: CodingGitSettings,
        private transport: typeof fetch = fetch,
    ) {
        this.key = codingGitKey(settings.secret);
    }

    private async call(
        path: string,
        init: {
            method: 'GET' | 'POST' | 'DELETE';
            body?: ReadableStream<Uint8Array> | string;
            json?: boolean;
            timeoutMs?: number;
            /** Ends the call early (the push's grant revoked). */
            signal?: AbortSignal;
        },
    ) {
        let response: Response;
        try {
            response = await this.transport(`${this.settings.url}${path}`, {
                method: init.method,
                headers: {
                    Authorization: `Bearer ${this.key}`,
                    ...(init.json ? { 'Content-Type': 'application/json' } : {}),
                },
                body: init.body,
                redirect: 'error',
                signal: AbortSignal.any([
                    AbortSignal.timeout(init.timeoutMs ?? 10 * 60_000),
                    ...(init.signal ? [init.signal] : []),
                ]),
                ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
            } as RequestInit);
        } catch {
            throw new CodingGitUnavailable('coding-git could not be reached.');
        }
        return response;
    }

    private async json<T>(path: string, init: Parameters<CodingGitClient['call']>[1]): Promise<T> {
        const response = await this.call(path, init);
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            throw new CodingGitUnavailable(`coding-git answered ${response.status}.`);
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new CodingGitUnavailable('coding-git’s answer was not JSON.');
        }
    }

    async refs(repository: string, has?: string) {
        const query = new URLSearchParams({ repository });
        if (has) {
            query.set('has', has);
        }
        const answer = record(await this.json<unknown>(`/mirror/refs?${query}`, { method: 'GET' }));
        // The tips become `have` lines sent to GitHub; ids only.
        if (!Array.isArray(answer.tips) || typeof answer.has !== 'boolean') {
            throw new CodingGitUnavailable('coding-git’s refs were malformed.');
        }
        return {
            tips: answer.tips.filter((tip): tip is string => typeof tip === 'string' && SHA.test(tip)),
            has: answer.has,
        };
    }

    refresh(repository: string, refs: Record<string, string>, pack: ReadableStream<Uint8Array> | null) {
        return this.json<{ refs: number }>(`/mirror/refresh?${new URLSearchParams({ repository })}`, {
            method: 'POST',
            body: framed({ refs, pack: !!pack }, pack),
        });
    }

    async inspect(meta: InspectMeta, pack: ReadableStream<Uint8Array>, signal?: AbortSignal) {
        return checkedVerdict(
            await this.json<unknown>('/inspect', {
                method: 'POST',
                body: framed(meta, pack),
                signal,
            }),
        );
    }

    /** The accepted push's pack, streamed. */
    async spool(id: string) {
        const response = await this.call(`/spool/${encodeURIComponent(id)}`, {
            method: 'GET',
        });
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new CodingGitUnavailable('The inspected push is gone.');
        }
        return response.body;
    }

    async dropSpool(id: string) {
        await this.call(`/spool/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        })
            .then((response) => response.body?.cancel())
            .catch(() => undefined);
    }

    async extract(repository: string, request: ExtractRequest) {
        return checkedExtraction(
            await this.json<unknown>(`/extract?${new URLSearchParams({ repository })}`, {
                method: 'POST',
                body: JSON.stringify(request),
                json: true,
            }),
        );
    }
}
