import type { ServerModule } from '../modules/contract.js';
import { Conversations, People } from '../workspace/contract.js';

import { chatSkills } from './registry.js';
import { chatSkillsSchema, skillSessions, skillsRepository } from './repository.js';
import { chatSkillRoutes } from './routes.js';
import { endSkillTool, workspaceSkillTools } from './tools.js';

/**
 * Chat skills (CB-143): `/compact`, `/grill-me`, `/help`, `/done`,
 * `/report`, `/unfurl` and the workspace's own, invoked by name at the start of a message. The Dot's
 * turn runs them (`dot-agent.ts`); this module owns their tables,
 * `/api/chat-skills` (the composer's menu, a chat's skill that is on, and
 * Settings → Chat skills) and the `end_skill` tool. `/unfurl`'s
 * `unfurl_link` reads the web, so the web module gives it.
 *
 * Its hooks build the repositories on the module context's connection:
 * the same one-per-database instances `layer.ts` offers as
 * `WorkspaceSkills` and `SkillSessions`. `routes` and `dotTools` stay
 * synchronous (their callers use the value at once), so they can't yield
 * the tags until the root binds the app's services for module hooks
 * (`ModuleRuntimeServices`).
 */
export const chatSkillsModule: ServerModule = {
    ...chatSkillsSchema,
    // The people and the chats are the workspace's `People` and
    // `Conversations`, from the app's services.
    routes: ({ db, services }) => {
        const repository = skillsRepository(db);
        const sessions = skillSessions(db);
        const people = services.get(People);
        const conversations = services.get(Conversations);
        return chatSkillRoutes({
            registry: chatSkills(repository, sessions),
            repository,
            sessions,
            workspace: {
                users: () => people.users(),
                readableThread: (...args) => conversations.readableThread(...args),
            },
        });
    },
    dotTools: ({ db, services }, turn) => [
        endSkillTool(turn, skillSessions(db)),
        ...workspaceSkillTools(turn, skillsRepository(db), services.get(People)),
    ],
};
