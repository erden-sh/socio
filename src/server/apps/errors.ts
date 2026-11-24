/**
 * The apps' refusal with its HTTP status, and where an app's files live in
 * its computer: shared by the registry (`service.ts`) and promotion
 * (`promotion.ts`), so neither imports the other for them.
 */

/** Where an app's token file lives in its computer's workspace. */
export const appEnvFile = (slug: string) => `.socio/apps/${slug}.env`;
export const appLogFile = (slug: string) => `.socio/apps/${slug}.log`;
/** The process group the platform last started for it (CB-291), so it stops that one. */
export const appPidFile = (slug: string) => `.socio/apps/${slug}.pid`;

export class AppError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 413 | 503 = 400,
    ) {
        super(message);
    }
}

/**
 * A repair whose app changed while it ran (a new registration, version or
 * status) or whose claim no longer holds: it stops before acting (CB-291).
 */
export class RepairSuperseded extends Error {
    constructor() {
        super('The repair was superseded.');
    }
}
