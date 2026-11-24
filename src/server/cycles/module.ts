import type { ServerModule } from '../modules/contract.js';

import { CycleUpkeep } from './contract.js';
import { cyclesSchema } from './migrations.js';

/**
 * Work cycles (CB-211): the service lives on the platform
 * (`platform.cycles`), where the runner asks it as each step of work
 * starts and ends; the module owns the tables and the tick that forgets
 * old submissions and ends cycles that waited too long.
 *
 * Its tick reads the service as `CycleUpkeep` (`contract.ts`), from the
 * app's services at the moment of use.
 */
export const cyclesModule: ServerModule = {
    ...cyclesSchema,
    tick: { everyMs: 60_000, run: ({ services }) => services.get(CycleUpkeep).tick() },
};
