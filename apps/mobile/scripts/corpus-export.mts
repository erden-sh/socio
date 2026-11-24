// The live corpus's export (scripts/pages-corpus.mts `export`), kept apart so
// tests/editor/corpus-export.test.ts runs it against a stubbed fetch. Each
// export replaces the last: the files the corpus owns and the device payload
// are deleted before anything is asked (corpus-folder.mts's
// `clearCorpusFiles`), so a page deleted or no longer readable since never
// stays to be tested or pushed, and an export that fails part way deletes what
// it wrote. A page or a Space's page list that answers 403 or 404 (deleted or
// unshared since it was listed) is skipped and counted, not a failure; any
// other error throws, never exits, and the account is signed out in `finally`
// whatever happened. Requests carry the smoke account's sign-in and a generic
// User-Agent, nothing else of anyone's.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { claimCorpusFolder, clearCorpusFiles } from './corpus-folder.mts';

export const USER_AGENT = 'research-script/0.1';

export class CorpusExportError extends Error {}

/** A Space or page id as a file name: plain characters only, so a write can't leave its folder. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** What an export wrote, and what it skipped as no longer readable (403 or 404). */
export interface ExportResult {
    readonly pages: number;
    readonly skipped: number;
}

/** A page or list the account can no longer read: skipped and counted. */
class Unreadable extends Error {}

export interface ExportOptions {
    readonly base: string;
    readonly email: string;
    readonly password: string;
    /** A folder corpus-folder.mts's `corpusFolder` accepted. */
    readonly folder: string;
    readonly fetch?: typeof fetch;
}

/** Signs in, writes each readable page as `<spaceId>/<pageId>.md` in place of the last export, signs out; the counts. */
export async function exportPages({
    base: given,
    email,
    password,
    folder,
    fetch: send = fetch,
}: ExportOptions): Promise<ExportResult> {
    const base = new URL(given).origin;
    claimCorpusFolder(folder);
    chmodSync(folder, 0o700);
    clearCorpusFiles(folder);

    const cookies = new Map<string, string>();
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await send(`${base}${path}`, {
            method,
            redirect: 'error',
            headers: {
                'User-Agent': USER_AGENT,
                Origin: base,
                ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(';');
            const at = pair!.indexOf('=');
            cookies.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
        }
        if (!response.ok && path === '/api/auth/sign-in/email') {
            // The usual causes: the deployment was recreated without the smoke accounts, or the password
            // file is older than the account. Creating an account there needs the owner's OK. Never the
            // email: the message is printed, and the status and origin are enough to look.
            throw new CorpusExportError(
                `Sign-in answered ${response.status}: check that the smoke account exists on ${base} (read-only, its auth_user table) and that the password file is current.`,
            );
        }
        if ((response.status === 403 || response.status === 404) && path.startsWith('/api/spaces/')) {
            throw new Unreadable();
        }
        if (!response.ok) {
            throw new CorpusExportError(`${method} ${path.replace(/\/[^/]+$/, '/…')} answered ${response.status}.`);
        }
        return response.json() as Promise<unknown>;
    };
    const plain = (id: string) => {
        if (!PLAIN_ID.test(id)) {
            throw new CorpusExportError('A Space or page id isn’t a plain name: nothing was kept.');
        }
        return id;
    };

    await call('POST', '/api/auth/sign-in/email', { email, password });
    let pages = 0;
    let skipped = 0;
    /** The answer, or null for a page or list the account can no longer read. */
    const readable = async (path: string) => {
        try {
            return await call('GET', path);
        } catch (error) {
            if (error instanceof Unreadable) {
                skipped += 1;
                return null;
            }
            throw error;
        }
    };
    let signOutFailure: string | null = null;
    try {
        const workspace = (await call('GET', '/api/workspace')) as { spaces?: { id: string }[] };
        for (const space of workspace.spaces ?? []) {
            const spacePath = `/api/spaces/${encodeURIComponent(space.id)}`;
            const summaries = (await readable(`${spacePath}/pages`)) as { id: string }[] | null;
            if (summaries === null) {
                continue;
            }
            const spaceFolder = join(folder, plain(space.id));
            mkdirSync(spaceFolder, { recursive: true, mode: 0o700 });
            if (!lstatSync(spaceFolder).isDirectory()) {
                throw new CorpusExportError('A Space’s folder in SOCIO_PAGES_CORPUS isn’t a folder: nothing was kept.');
            }
            for (const summary of summaries) {
                const pageId = plain(summary.id);
                const page = (await readable(`${spacePath}/pages/${encodeURIComponent(pageId)}`)) as {
                    content: string;
                } | null;
                if (page === null) {
                    continue;
                }
                writeFileSync(join(spaceFolder, `${pageId}.md`), page.content, { mode: 0o600 });
                pages += 1;
            }
        }
    } catch (error) {
        // Half an export is never tested or pushed.
        clearCorpusFiles(folder);
        throw error;
    } finally {
        try {
            await call('POST', '/api/auth/logout', {});
        } catch (error) {
            // Thrown below, after a good export: an export's own error goes first.
            signOutFailure = error instanceof CorpusExportError ? error.message : 'no answer';
        }
    }
    if (signOutFailure !== null) {
        throw new CorpusExportError(
            `The export finished, but signing out failed (${signOutFailure}): sign the smoke account out of its other sessions.`,
        );
    }
    return { pages, skipped };
}
