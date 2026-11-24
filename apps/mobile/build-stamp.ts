// Which build this is, from the environment `expo prebuild` runs in (README, Builds):
//
// - SOCIO_BUILD_NUMBER, a positive integer, is iOS's CFBundleVersion (`ios.buildNumber`) and
//   Android's versionCode. The preview and release builders pass the commit count of the main they
//   build (`git rev-list --count HEAD`), so a later main is always a higher build and iOS installs
//   it over the one on the phone. Unset means 1, for local development builds.
// - SOCIO_BUILD_COMMIT, the short sha built, and SOCIO_BUILD_DATE, the ISO date it was built: both
//   optional, embedded in the config's `extra` so Settings can say where the build came from.
//
// A value that isn't one of these throws, so a typo fails the build instead of shipping build 1.

/** Google Play's ceiling for versionCode. */
export const MAX_BUILD_NUMBER = 2_100_000_000;

/** The build number of a build made with no SOCIO_BUILD_NUMBER. */
export const DEFAULT_BUILD_NUMBER = 1;

export interface BuildStamp {
    /** CFBundleVersion and versionCode. */
    buildNumber: number;
    /** The short sha built, lowercase, or null when not given. */
    commit: string | null;
    /** The ISO date (or date and time) it was built, or null when not given. */
    date: string | null;
}

/** The variables `buildStamp` reads, as a builder sets them. */
export const BUILD_STAMP_VARIABLES = ['SOCIO_BUILD_NUMBER', 'SOCIO_BUILD_COMMIT', 'SOCIO_BUILD_DATE'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** The build stamp the environment gives. Empty counts as unset, as a shell's `NAME=` does. */
export function buildStamp(env: Readonly<Record<string, string | undefined>>): BuildStamp {
    return {
        buildNumber: buildNumber(env.SOCIO_BUILD_NUMBER),
        commit: buildCommit(env.SOCIO_BUILD_COMMIT),
        date: buildDate(env.SOCIO_BUILD_DATE),
    };
}

function buildNumber(value: string | undefined): number {
    if (value === undefined || value === '') {
        return DEFAULT_BUILD_NUMBER;
    }
    const number = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(number)) {
        throw new Error(
            `SOCIO_BUILD_NUMBER "${value}" isn't a positive whole number: use the commit count of the build (git rev-list --count HEAD), or leave it unset for 1.`,
        );
    }
    if (number > MAX_BUILD_NUMBER) {
        throw new Error(
            `SOCIO_BUILD_NUMBER ${value} is above ${MAX_BUILD_NUMBER}, the highest versionCode Google Play takes.`,
        );
    }
    return number;
}

function buildCommit(value: string | undefined): string | null {
    if (value === undefined || value === '') {
        return null;
    }
    if (!/^[0-9a-f]{7,40}$/i.test(value)) {
        throw new Error(
            `SOCIO_BUILD_COMMIT "${value}" isn't a commit sha (7 to 40 hex characters), or leave it unset.`,
        );
    }
    return value.toLowerCase();
}

function buildDate(value: string | undefined): string | null {
    if (value === undefined || value === '') {
        return null;
    }
    if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error(
            `SOCIO_BUILD_DATE "${value}" isn't an ISO date (2026-11-09 or 2026-11-09T14:30:00Z), or leave it unset.`,
        );
    }
    return value;
}
