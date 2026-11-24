import type { ServerModule } from '../modules/contract.js';

import { chatNamesSchema } from './migrations.js';

/**
 * CB-292: content-based name suggestions for rooms and chats. The service
 * (`platform.chatNames`) evaluates cheap triggers after each turn and, when
 * one fires, asks the model for a concise name and stores a single pending
 * suggestion per chat. Routes live with the conversation routes in
 * `workspace-routes.ts` (under `/chats/:id/name-suggestion`); authorization
 * is room admins for shared rooms, the owner for single-user chats. No
 * name is applied without explicit approval.
 */
export const chatNamesModule: ServerModule = {
    ...chatNamesSchema,
};
