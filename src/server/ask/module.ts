import type { ServerModule } from '../modules/contract.js';

import { Ask } from './contract.js';
import { askSchema } from './migrations.js';
import { askRoutes } from './routes.js';

/**
 * "Ask a socio" (CB-26): the panel on every screen, bound to one
 * conversation per person, item (page, issue, dataset, schedule, or none)
 * and socio. Its socio is told about the item in each turn's note, read
 * again with the person's access every time (`AskService.turnNote`). The
 * hooks use the `Ask` the layer graph made (`composition/ask.ts`), from
 * the module's services; a platform built on its own offers one made over
 * its members (`composition/module-services.ts`).
 */
export const askModule: ServerModule = {
    ...askSchema,
    routes: ({ services }) => askRoutes(services.get(Ask)),
    dotTurnNote: ({ services }, turn) => services.get(Ask).turnNote(turn),
};
