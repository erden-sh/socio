/**
 * The newest release a person has seen in What's new (CB-166), kept per
 * person on the server: `GET /api/releases/seen` gives it, and
 * `POST /api/releases/seen { version }` moves it forward, never back.
 */
export interface ReleaseSeen {
    /** A version like `0.7.0`; null until the person's first visit. */
    lastSeen: string | null;
}

/** When a person was first shown a release's card (CB-166). */
export interface ReleaseView {
    version: string;
    /** Epoch ms. */
    firstSeenAt: number;
}

/**
 * `GET /api/admin/people/:id/releases` (admins): which releases a person
 * was shown and when, for support, and the newest they opened What's new
 * on.
 */
export interface PersonReleases {
    userId: string;
    lastSeen: string | null;
    views: ReleaseView[];
}

/** Versions one `POST /api/releases/views` may carry. */
export const MAX_RELEASE_VIEWS = 50;

/** The longest version the server keeps. */
export const MAX_RELEASE_VERSION = 64;

// SemVer 2.0.0 without the `v`: `0.7.0`, `0.8.0-rc.1`, `0.7.0+build.5`.
const VERSION =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether `value` is a release version (SemVer, no `v`). */
export const isReleaseVersion = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= MAX_RELEASE_VERSION && VERSION.test(value);

/**
 * Orders two release versions by SemVer precedence: negative when `a` is
 * older. A pre-release comes before its release; build metadata is
 * ignored. Both must be `isReleaseVersion`.
 */
export function compareVersions(a: string, b: string): number {
    const [, ...left] = VERSION.exec(a)!;
    const [, ...right] = VERSION.exec(b)!;
    for (let index = 0; index < 3; index++) {
        const difference = Number(left[index]) - Number(right[index]);
        if (difference) {
            return Math.sign(difference);
        }
    }
    const [preA, preB] = [left[3], right[3]];
    if (preA === preB) {
        return 0;
    }
    if (preA === undefined) {
        return 1;
    }
    if (preB === undefined) {
        return -1;
    }
    const partsA = preA.split('.');
    const partsB = preB.split('.');
    for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
        const [x, y] = [partsA[index], partsB[index]];
        if (x === undefined) {
            return -1;
        }
        if (y === undefined) {
            return 1;
        }
        if (x === y) {
            continue;
        }
        const [numberX, numberY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
        if (numberX && numberY) {
            return Math.sign(Number(x) - Number(y));
        }
        // Numeric identifiers come before alphanumeric ones.
        if (numberX !== numberY) {
            return numberX ? -1 : 1;
        }
        return x < y ? -1 : 1;
    }
    return 0;
}
