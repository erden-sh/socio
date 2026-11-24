import { compareVersions, isReleaseVersion } from '../updates/release-seen.js';

/**
 * A plugin's release notes (CB-527): its catalog manifest's optional
 * `releaseNotes`, newest first. The workspace reads them when the plugin
 * is installed or updated, never live, and keeps each plugin's history.
 * `notes` is Markdown the host renders sanitized: no raw HTML, no images
 * or other remote fetches, links opened as any outside link.
 */
export interface PluginReleaseNote {
    /** SemVer without the `v`: `1.2.0`. */
    version: string;
    /** YYYY-MM-DD. */
    date: string;
    /** One line, optional. */
    title?: string;
    /** Markdown. */
    notes: string;
}

/** Versions one manifest may carry. */
export const PLUGIN_RELEASE_NOTES_MAX = 20;
/** The longest `notes` of one version, in UTF-8 bytes. */
export const PLUGIN_RELEASE_NOTE_BYTES = 8 * 1024;
/** All of a manifest's `releaseNotes` together (versions, dates, titles and notes), in UTF-8 bytes. */
export const PLUGIN_RELEASE_NOTES_BYTES = 64 * 1024;
/** The longest `title`, in characters. */
export const PLUGIN_RELEASE_TITLE_MAX = 120;
/** Versions the workspace keeps per installed plugin, across updates. */
export const PLUGIN_RELEASE_HISTORY_MAX = 50;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Whether `value` is a real calendar day written YYYY-MM-DD. */
export function isReleaseDate(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    const match = DATE.exec(value);
    if (!match) {
        return false;
    }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks a manifest's `releaseNotes` and answers them, clean: a list of
 * 1 to `PLUGIN_RELEASE_NOTES_MAX` entries, newest first with no version
 * twice, the first one the manifest's own `version`, each `notes` at most
 * `PLUGIN_RELEASE_NOTE_BYTES` and all of them at most
 * `PLUGIN_RELEASE_NOTES_BYTES`. Throws an Error naming `from` otherwise.
 */
export function parsePluginReleaseNotes(value: unknown, from: string, manifestVersion: string): PluginReleaseNote[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > PLUGIN_RELEASE_NOTES_MAX) {
        throw new Error(`${from} releaseNotes must be a list of 1 to ${PLUGIN_RELEASE_NOTES_MAX} versions.`);
    }
    const notes: PluginReleaseNote[] = [];
    let total = 0;
    for (const entry of value) {
        if (!isRecord(entry)) {
            throw new Error(`${from} releaseNotes entry is not an object.`);
        }
        for (const key of Object.keys(entry)) {
            if (!['version', 'date', 'title', 'notes'].includes(key)) {
                throw new Error(`${from} releaseNotes field ${key.slice(0, 64)} is not allowed.`);
            }
        }
        const { version, date, title, notes: text } = entry;
        if (!isReleaseVersion(version)) {
            throw new Error(`${from} releaseNotes version ${String(version).slice(0, 64)} must be SemVer, like 1.2.0.`);
        }
        const previous = notes.at(-1);
        if (previous && compareVersions(version, previous.version) >= 0) {
            throw new Error(`${from} releaseNotes must be newest first, each version once (${version}).`);
        }
        if (!isReleaseDate(date)) {
            throw new Error(`${from} releaseNotes ${version}: date must be a day, YYYY-MM-DD.`);
        }
        if (
            title !== undefined &&
            (typeof title !== 'string' ||
                !title.trim() ||
                title.length > PLUGIN_RELEASE_TITLE_MAX ||
                /[\r\n]/.test(title))
        ) {
            throw new Error(
                `${from} releaseNotes ${version}: title is one line of at most ${PLUGIN_RELEASE_TITLE_MAX} characters.`,
            );
        }
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error(`${from} releaseNotes ${version} needs notes.`);
        }
        const size = bytes(text);
        if (size > PLUGIN_RELEASE_NOTE_BYTES) {
            throw new Error(`${from} releaseNotes ${version}: notes are at most ${PLUGIN_RELEASE_NOTE_BYTES} bytes.`);
        }
        total += size + bytes(version) + bytes(date) + (title === undefined ? 0 : bytes(title));
        if (total > PLUGIN_RELEASE_NOTES_BYTES) {
            throw new Error(`${from} releaseNotes are at most ${PLUGIN_RELEASE_NOTES_BYTES} bytes in all.`);
        }
        notes.push({ version, date, ...(title === undefined ? {} : { title: title.trim() }), notes: text });
    }
    if (notes[0]!.version !== manifestVersion) {
        throw new Error(
            `${from} releaseNotes start with ${notes[0]!.version}, but the manifest's version is ${manifestVersion}.`,
        );
    }
    return notes;
}
