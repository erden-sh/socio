const DAY = 24 * 60 * 60_000;

/** Socios' daily limits count the notifications of this window. */
export const LIMIT_WINDOW_MS = DAY;
/** An image's token works this long. */
export const IMAGE_TTL_MS = 7 * DAY;
/** In-app notices older than this aren't shown any more. */
export const IN_APP_MS = DAY;
/** At most this many in-app notices show at once. */
export const IN_APP_SHOWN = 5;
