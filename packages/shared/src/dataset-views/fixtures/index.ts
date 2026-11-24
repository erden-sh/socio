/**
 * The view contract's fixtures (CB-451): one per layout and one
 * with parts from a newer release. Both clients run every one; see
 * `./types.ts` for what each holds them to.
 */
import { BOARD_FIXTURE } from './board.js';
import { CALENDAR_FIXTURE } from './calendar.js';
import { GALLERY_FIXTURE } from './gallery.js';
import { LIST_FIXTURE } from './list.js';
import { TABLE_FIXTURE } from './table.js';
import type { ViewFixture } from './types.js';
import { UNKNOWN_FIXTURE } from './unknown.js';

export { BOOKINGS_FIELDS, BOOKINGS_FILES, BOOKINGS_ROWS, BOOKINGS_USERS, FIXTURE_CONTEXT } from './bookings.js';
export type { ViewFixture } from './types.js';
export { ACME_DIFF, ACME_FILES, ACME_MINE, ACME_THEIRS, ACME_USERS, WRITE_FIXTURES } from './writes.js';
export type { WriteFixtureName } from './writes.js';
export { BOARD_FIXTURE, CALENDAR_FIXTURE, GALLERY_FIXTURE, LIST_FIXTURE, TABLE_FIXTURE, UNKNOWN_FIXTURE };

export const VIEW_FIXTURES: readonly ViewFixture[] = [
    TABLE_FIXTURE,
    LIST_FIXTURE,
    BOARD_FIXTURE,
    CALENDAR_FIXTURE,
    GALLERY_FIXTURE,
    UNKNOWN_FIXTURE,
];
