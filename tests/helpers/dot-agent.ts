// A Dot's agent for tests, built as the app builds one: `DotAgentCore`
// and `DotAgentFactoryCore` over `dotTurnServices`, from a store, workspace
// and config, with the arguments the composition's `DotAgent` and
// `DotAgentFactory` wrappers took before they were dropped.
import { dotTurnServices, type DotAgentConfig } from '../../src/server/composition/app/dot-turns.js';
import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import { DotAgentCore, DotAgentFactoryCore, type DotAgentOptions } from '../../src/server/dots/dot-agent.js';

import type { Store } from './stores.js';

/** `DotAgentCore` with its services built over the store, workspace and config. */
export class DotAgent extends DotAgentCore {
    constructor(
        store: Store,
        workspace: WorkspaceStore,
        config: DotAgentConfig,
        dotId: string,
        channel = false,
        actingUserId?: string,
        options: DotAgentOptions = {},
    ) {
        super(
            dotTurnServices(store, workspace, config),
            store,
            workspace,
            config,
            dotId,
            channel,
            actingUserId,
            options,
        );
    }
}

/** `DotAgentFactoryCore` with its services built over the store, workspace and config. */
export class DotAgentFactory extends DotAgentFactoryCore {
    constructor(
        store: Store,
        workspace: WorkspaceStore,
        config: DotAgentConfig,
        shared: Pick<DotAgentOptions, 'inference' | 'extensions'> = {},
    ) {
        super(dotTurnServices(store, workspace, config), store, workspace, config, shared);
    }
}
