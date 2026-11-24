import { existsSync, readFileSync } from 'node:fs';

import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { parseReleaseNotes } from '@socio/shared/updates/release-notes';
import { RELEASE_TAG, type Release, type ReleaseSummary, type ReleasesResponse } from '@socio/shared/updates/releases';

import type { ReleaseData } from './contract.js';

// Kept for `composition/http/index.ts`, which this batch may not edit;
// every other importer reads it from `contract.ts`.
export type { ReleaseData } from './contract.js';

/**
 * Socio's version and releases (CB-165, CB-168). The build writes them to
 * dist/server/releases.json (scripts/release-data.mjs), since docs/ isn't
 * in the app's image; from the source tree (development, tests) they come
 * from package.json and docs/RELEASE-NOTES.md as they are now, with the
 * commit from APP_COMMIT when it is set.
 */
/** Where the data comes from: the build's file, else the source tree. */
export interface ReleaseFiles {
    built: URL;
    notes: URL;
    /** package.json, from the source tree, then from the build. */
    pkg: URL[];
}
const FILES: ReleaseFiles = {
    built: new URL('../../releases.json', import.meta.url),
    notes: new URL('../../../docs/RELEASE-NOTES.md', import.meta.url),
    pkg: [new URL('../../../package.json', import.meta.url), new URL('../../../../package.json', import.meta.url)],
};

const packageVersion = (files: URL[]) => {
    for (const pkg of files) {
        if (existsSync(pkg)) {
            try {
                return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
            } catch {
                // The next one, else unknown.
            }
        }
    }
    return '0.0.0';
};

/**
 * Reads the build's file, else the source tree's; an empty list when
 * neither is there, or when what is there can't be read (logged).
 */
export function loadReleaseData(log: (line: string) => void = console.warn, files: ReleaseFiles = FILES): ReleaseData {
    const commit = process.env.APP_COMMIT?.trim() || null;
    try {
        if (existsSync(files.built)) {
            return JSON.parse(readFileSync(files.built, 'utf8')) as ReleaseData;
        }
        const releases = existsSync(files.notes) ? parseReleaseNotes(readFileSync(files.notes, 'utf8')).releases : [];
        return { version: packageVersion(files.pkg), commit, releases };
    } catch (error) {
        // A broken file never takes /healthz or /api/releases down with it.
        log(
            `Releases: could not read the release notes (${error instanceof Error ? error.message : 'unknown error'}); none are shown.`,
        );
        return { version: packageVersion(files.pkg), commit, releases: [] };
    }
}

let cached: ReleaseData | undefined;
/** The running app's releases, read once. */
export const releaseData = () => (cached ??= loadReleaseData());

export const releaseSummary = ({ notesMarkdown: _notes, ...summary }: Release): ReleaseSummary => summary;

/**
 * `GET /api/releases?limit=N` (newest first, with the running version)
 * and `GET /api/releases/:tag`, for anyone signed in. `:tag` is only ever
 * a `v0.1.2`, so other paths under `/api/releases` stay free. A page
 * after the first asks `before=<tag>`, the `nextCursor` of the page
 * before it (CB-166).
 */
export function releaseRoutes(data: () => ReleaseData = releaseData) {
    const routes = new Hono<AppEnv>();
    routes.get('/releases', (c) => {
        const { version, commit, releases } = data();
        const asked = c.req.query('limit');
        if (asked !== undefined && !/^\d+$/.test(asked)) {
            return c.json({ error: 'limit must be a whole number, 0 or more.' }, 400);
        }
        const limit = asked === undefined ? releases.length : Number(asked);
        // Just the version: no page, so no cursor either.
        if (limit === 0) {
            return c.json({
                current: version,
                commit,
                releases: [],
            } satisfies ReleasesResponse);
        }
        const before = c.req.query('before');
        const start = before === undefined ? 0 : releases.findIndex((release) => release.tag === before) + 1;
        if (before !== undefined && (!RELEASE_TAG.test(before) || start === 0)) {
            return c.json({ error: 'before must be the tag of a release.' }, 400);
        }
        const page = releases.slice(start, start + limit);
        return c.json({
            current: version,
            commit,
            releases: page.map(releaseSummary),
            nextCursor: start + limit < releases.length ? (page.at(-1)?.tag ?? null) : null,
        } satisfies ReleasesResponse);
    });
    routes.get('/releases/:tag{v\\d+\\.\\d+\\.\\d+}', (c) => {
        const tag = c.req.param('tag');
        const release = data().releases.find((item) => item.tag === tag);
        if (!release) {
            return c.json({ error: 'No such release.' }, 404);
        }
        return c.json(release satisfies Release);
    });
    return routes;
}
