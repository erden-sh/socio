import type { PlatformConfig } from '../../src/server/composition/config.js';
import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
/**
 * What a test's Telegram channel uses of other features
 * (`TelegramTurnServices`), as the graph's tags offer them
 * (`telegram/layer.ts`, `ChannelServices`): each turn's channel-mode Dot
 * agent over the test's stores and config, the workspace's chat skills,
 * and the reactions on a socio's replies.
 */
import { dotReplies } from '../../src/server/context/reaction-routes.js';
import { messageReactions } from '../../src/server/context/reactions.js';
import type { DotExtensions } from '../../src/server/dots/contract.js';
import type { InferenceResolver } from '../../src/server/inference/contract.js';
import { replayMessages } from '../../src/server/replay/replay.js';
import { chatSkills } from '../../src/server/skills/registry.js';
import { skillsRepository } from '../../src/server/skills/repository.js';
import type { TelegramTurnServices } from '../../src/server/telegram/slices.js';
import type { RunnerShape } from '../../src/server/turns/contract.js';

import { DotAgentFactory } from './dot-agent.js';
import type { Store } from './stores.js';

export function telegramServices({
    store,
    workspace,
    config,
    runner,
    inference,
    extensions,
}: {
    store: Store;
    workspace: WorkspaceStore;
    config: PlatformConfig;
    runner: Pick<RunnerShape, 'rowsMentioning'>;
    inference?: InferenceResolver;
    extensions?: DotExtensions;
}): TelegramTurnServices {
    return {
        agents: new DotAgentFactory(store, workspace, config, { inference, extensions }),
        skills: chatSkills(skillsRepository(workspace.db)),
        reactions: messageReactions(workspace.db),
        replies: dotReplies(runner, { messages: replayMessages }),
    };
}
