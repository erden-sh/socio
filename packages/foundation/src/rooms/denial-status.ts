import type { RoomDenial } from '@socio/shared/rooms/rooms';

/**
 * The HTTP status a refusal of the access rule (CB-208) is answered with.
 * `not_found` is a 404, as for another person's chat, so ids can't be
 * probed.
 */
export const roomDenialStatus = (reason: RoomDenial) =>
    reason === 'not_found' ? 404 : reason === 'not_admin' || reason === 'not_initiator' ? 403 : 409;
