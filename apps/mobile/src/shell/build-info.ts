// Which build is installed, and whether it changed since the app last ran (the owner installs
// Preview builds over the air and needs to know which one is on the phone, and whether an install
// took effect). No React Native, so tests/shell runs it under Node; src/platform/build-info.ts reads
// the installed binary.
//
// - Settings' footer (ChatGPT's): "Version 0.1.0 (2829) · Preview", then the commit and the build
//   date when the build was given them (build-stamp.ts). Tapping it copies both lines.
// - The notice: the build number the app last ran is the registry's (migration 6), per phone, never
//   per workspace. When the running build differs, one notice shows, once: "Updated to build 2829
//   (was 2790)" or "Older build installed: 2790 (was 2829)". The first run keeps the number and says
//   nothing. The new number is kept before the notice shows, so it never shows twice.

export type BuildVariant = 'development' | 'preview' | 'production';

export interface BuildInfo {
    /** The installed binary's version (CFBundleShortVersionString, versionName). */
    readonly version: string;
    /** Its build number (CFBundleVersion, versionCode), or null when it can't be read. */
    readonly build: number | null;
    readonly variant: BuildVariant;
    /** The short sha it was built from, when the build was given one. */
    readonly commit: string | null;
    /** The ISO date it was built, when the build was given one. */
    readonly date: string | null;
}

const VARIANT_LABELS: Record<BuildVariant, string | null> = {
    development: 'Development',
    preview: 'Preview',
    // A store build says nothing more than its version, as ChatGPT's does.
    production: null,
};

/** The footer's first line: "Version 0.1.0 (2829) · Preview". */
export function versionLine(info: BuildInfo): string {
    const build = info.build === null ? '' : ` (${info.build})`;
    const variant = VARIANT_LABELS[info.variant];
    return `Version ${info.version}${build}${variant === null ? '' : ` · ${variant}`}`;
}

/** The footer's second line, "Commit 1a2b3c4 · Built Nov 9, 2026", or null when the build knows neither. */
export function originLine(info: BuildInfo): string | null {
    const parts = [
        info.commit === null ? null : `Commit ${info.commit.slice(0, 7)}`,
        info.date === null ? null : `Built ${builtOn(info.date)}`,
    ].filter((part) => part !== null);
    return parts.length === 0 ? null : parts.join(' · ');
}

/** What tapping the footer copies: both lines, the commit in full, for a bug report. */
export function buildCopyText(info: BuildInfo): string {
    const origin = [
        info.commit === null ? null : `commit ${info.commit}`,
        info.date === null ? null : `built ${info.date}`,
    ].filter((part) => part !== null);
    return [versionLine(info), ...origin].join(' · ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 9, 2026" from the build's ISO date, by its own calendar date (no time zone shifts it). */
function builtOn(iso: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
    if (match === null || month === undefined) {
        return iso;
    }
    return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** The build number in the binary's CFBundleVersion or versionCode: a positive whole number, else null. */
export function parseBuildNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value).trim();
    if (!/^[1-9]\d*$/.test(text)) {
        return null;
    }
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : null;
}

export type BuildChange =
    | { readonly kind: 'none' }
    | { readonly kind: 'first-run'; readonly build: number }
    | { readonly kind: 'higher' | 'lower'; readonly build: number; readonly was: number };

/** What changed since the build the app last ran (`previous`, null when none was kept). */
export function buildChange(previous: number | null, current: number): BuildChange {
    if (previous === null) {
        return { kind: 'first-run', build: current };
    }
    if (previous === current) {
        return { kind: 'none' };
    }
    return { kind: current > previous ? 'higher' : 'lower', build: current, was: previous };
}

/** The notice's words for a change, or null when there is nothing to say. */
export function buildNoticeText(change: BuildChange): string | null {
    switch (change.kind) {
        case 'higher':
            return `Updated to build ${change.build} (was ${change.was})`;
        case 'lower':
            return `Older build installed: ${change.build} (was ${change.was})`;
        default:
            return null;
    }
}

/**
 * Whether the notice's 15 s run while the app is in `state` (AppState's): not while it is inactive or
 * in the background, so a notice that shows once is seen. A state AppState doesn't know yet at launch
 * ('unknown') counts as in front.
 */
export function noticeClockRuns(state: string): boolean {
    return state !== 'inactive' && state !== 'background';
}

export interface BuildNotice {
    readonly kind: 'higher' | 'lower';
    readonly text: string;
}

/** Where the last build is kept: the registry's `lastBuild` and `setLastBuild`. */
export interface LastBuildStore {
    lastBuild(): Promise<number | null>;
    setLastBuild(build: number): Promise<void>;
}

/** The one notice of this run, if any, for the app's root to show until dismissed. */
export interface BuildNoticeSource {
    get(): BuildNotice | null;
    subscribe(listener: () => void): () => void;
    /** Reads the last build, keeps `current`, and holds the notice a change makes. Never throws. */
    check(store: LastBuildStore, current: number | null): Promise<void>;
    dismiss(): void;
}

export function createBuildNotice(onError: (error: unknown) => void = () => {}): BuildNoticeSource {
    let notice: BuildNotice | null = null;
    let checked = false;
    const listeners = new Set<() => void>();
    const set = (next: BuildNotice | null) => {
        if (next === notice) {
            return;
        }
        notice = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };
    return {
        get: () => notice,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        check: async (store, current) => {
            // Once per process: a launch that opens the store again (Try again) says nothing new.
            if (checked || current === null) {
                return;
            }
            checked = true;
            try {
                const change = buildChange(await store.lastBuild(), current);
                if (change.kind === 'none') {
                    return;
                }
                // Kept before it shows: a kill now never shows it again.
                await store.setLastBuild(current);
                const text = buildNoticeText(change);
                if (text !== null && change.kind !== 'first-run') {
                    set({ kind: change.kind, text });
                }
            } catch (error) {
                onError(error);
            }
        },
        dismiss: () => set(null),
    };
}

/**
 * The build number the notice compares, from the binary alone (socio-device's appBuild), or null.
 * Never the embedded config's: in a development client that is Metro's, from whatever shell started
 * it, and keeping it as the last build could set off a false "Older build installed" later.
 */
export function installedBuildNumber(native: { readonly build: string } | null): number | null {
    return parseBuildNumber(native?.build);
}

/** The installed build from what the binary says (`native`) and the config embedded in it. */
export function readBuildInfo(
    native: { readonly version: string; readonly build: string } | null,
    embedded: {
        readonly version?: string;
        readonly ios?: { readonly buildNumber?: string } | null;
        readonly android?: { readonly versionCode?: number } | null;
        readonly extra?: { readonly [key: string]: unknown } | null;
    } | null,
    variant: BuildVariant,
    platform: 'ios' | 'android',
): BuildInfo {
    // The binary's own values first: a development client may load a config from another build.
    const embeddedBuild = platform === 'ios' ? embedded?.ios?.buildNumber : embedded?.android?.versionCode;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
    return {
        version: text(native?.version) ?? text(embedded?.version) ?? '0.0.0',
        build: parseBuildNumber(native?.build) ?? parseBuildNumber(embeddedBuild),
        variant,
        commit: text(embedded?.extra?.buildCommit),
        date: text(embedded?.extra?.buildDate),
    };
}
