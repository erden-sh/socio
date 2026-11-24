/**
 * What `telegram/` calls on the rest of the app, as slices of other
 * features' contracts.
 * It replaces `platform-needs.ts`: no class of another folder is named here.
 * `WorkspaceStore` and the core store satisfy these slices, and the composition
 * (`composition/telegram.ts`) hands them in.
 */
import type { UnitOfWork } from '@socio/data/uow';

import type { DotRepliesShape, ReactionsShape } from '../context/contract.js';
import type { DotAgentsShape } from '../dots/contract.js';
import type { MemoryRepository } from '../memory/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { SkillRegistryShape } from '../skills/contract.js';
import type { AuditShape, ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { TelegramLinks } from './telegram-links.js';

/**
 * The workspace as the channel and its direct messages use it: the
 * people, the socios, the conversations they bind, the audit, the
 * Telegram links store (`WorkspaceStore.telegram`) and the unit of work
 * a new conversation's binding runs in.
 */
export type TelegramWorkspace = Pick<PeopleShape, 'users'> &
    Pick<SociosShape, 'dot' | 'dotsFor' | 'companyDots' | 'canUseDot'> &
    Pick<ConversationsShape, 'thread' | 'bindThread' | 'readableThread'> &
    Pick<AuditShape, 'audit'> & {
        readonly telegram: TelegramLinks;
        readonly data: { readonly uow: UnitOfWork };
    };

/** The settings (paused or not) and the person's memories (`/memories`, the buttons). */
export type TelegramStore = Pick<WorkspaceSettingsShape, 'settings'> & {
    readonly memoryItems: MemoryRepository;
};

/**
 * Other features' services the channel uses, from their tags
 * (`telegram/layer.ts`, `ChannelServices`): the socio's agent for a turn
 * (`DotAgents`), the chat skills for the command menus (`SkillRegistry`),
 * and the reactions on a socio's replies (`Reactions`, `DotReplies`).
 */
export interface TelegramTurnServices {
    readonly agents: DotAgentsShape;
    readonly skills: Pick<SkillRegistryShape, 'list'>;
    readonly reactions: Pick<ReactionsShape, 'add' | 'remove'>;
    readonly replies: DotRepliesShape;
}
