import { Media } from '../media/contract.js';
import type { ServerModule } from '../modules/contract.js';

import { computerTools } from './computer-tools.js';
import { Computers } from './contract.js';

/**
 * Computers: each Dot's isolated persistent computer. The service is
 * `platform.computers` (also behind the routes and the data space); the
 * module owns the permissions and audit tables and gives a Dot the
 * `computer_*` tools once the supervisor is set up. A screenshot is kept
 * as an attachment of the turn's conversation (CB-157). File and shell
 * requests require the isolated principal runtime (CB-227). `dotTools`
 * stays synchronous, as the registry calls it: it reads the `Computers`
 * service and media's `Media`, which keeps the screenshots, from the app's
 * services.
 */
export const computersModule: Omit<ServerModule, 'id' | 'migrations'> = {
    dotTools: ({ services }, turn) => {
        const computers = services.get(Computers);
        return computers.configured
            ? computerTools(
                  computers,
                  turn.dot.id,
                  turn.check,
                  turn.signal,
                  turn.userId,
                  // Screenshots are kept as the conversation's attachments (CB-157).
                  {
                      save: (image) =>
                          services.get(Media).saveToolImage(
                              {
                                  userId: turn.userId,
                                  dotId: turn.dot.id,
                                  threadId: turn.threadId,
                              },
                              image,
                          ),
                  },
                  !turn.dot.ownerId,
              )
            : [];
    },
};
