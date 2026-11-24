import { TEAM_OWNER_PREFIX } from '@socio/shared/rooms/rooms';

/** Owner of a team (forum topic) conversation; no person signs in as it. */
export const teamOwner = (chatId: string) => `${TEAM_OWNER_PREFIX}${chatId}`;
