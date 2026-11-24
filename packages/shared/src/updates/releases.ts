/**
 * Socio's releases (CB-165, CB-168), as `GET /api/releases` and
 * `GET /api/releases/:tag` answer them. They come from
 * docs/RELEASE-NOTES.md, parsed when the app is built
 * (release-notes.ts, scripts/release-data.mjs).
 */

/** One line of a release's card; `issue` is a key such as "CB-157". */
export type ReleaseHighlight = { title: string; issue?: string };

export type ReleaseSummary = {
    /** "0.7.0", without the v. */
    version: string;
    /** "v0.7.0": the git tag. */
    tag: string;
    /** YYYY-MM-DD. */
    date: string;
    /** One or two plain sentences, for cards. */
    summary: string;
    /** Three to five, for cards. */
    highlights: ReleaseHighlight[];
    /** "/releases/v0.7.0". */
    url: string;
};

/** A release with its notes: its New, Changed, Fixed and Upgrading sections. */
export type Release = ReleaseSummary & { notesMarkdown: string };

/** `GET /api/releases?limit=N`: newest first. */
export type ReleasesResponse = {
    /** The running app's version ("0.7.0"), from package.json at build time. */
    current: string;
    /** The commit it was built from (short), when the build knew it. */
    commit: string | null;
    releases: ReleaseSummary[];
    /**
     * The `before` for the next, older page (`?limit=N&before=<tag>`), or
     * null when there is none (CB-166). Left out with `limit=0`.
     */
    nextCursor?: string | null;
};

/** The page for a release. */
export const releasePath = (tag: string) => `/releases/${tag}`;

/** A release's tag: `v` and three numbers. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
