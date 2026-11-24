import { createHash } from 'node:crypto';

import type { Message } from '@ag-ui/core';

import type { ChatSkill } from '@socio/foundation/skills/chat-skill';
import { textOnly } from '@socio/foundation/skills/skill-actions';
import { messageText } from '@socio/foundation/turns/media-parts';
import {
    invokedSkill,
    skillCommand,
    skillDocument,
    BUILT_IN_SKILLS,
    type ChatSkillLock,
} from '@socio/shared/chat/chat-skills';

import type {
    Invocation,
    SkillRegistryShape,
    SkillSession,
    SkillSessionsRepository,
    WorkspaceSkillsRepository,
} from './contract.js';
import { provenanceOf } from './domain/repositories.js';
import { GRILL_ME_INSTRUCTIONS, GRILL_ME_SOURCE } from './grill-me.js';
import { REPORT_INSTRUCTIONS, REPORT_SOURCE } from './report.js';
import { UNFURL_INSTRUCTIONS, UNFURL_SOURCE } from './unfurl.js';

const digest = (skill: Parameters<typeof skillDocument>[0]) =>
    createHash('sha256').update(skillDocument(skill)).digest('hex');

/** The built-in prompt skills' instructions and sources, by name. */
const PROMPTS: Record<string, { instructions: string; source: Omit<ChatSkillLock, 'sha256'> }> = {
    'grill-me': { instructions: GRILL_ME_INSTRUCTIONS, source: GRILL_ME_SOURCE },
    report: { instructions: REPORT_INSTRUCTIONS, source: REPORT_SOURCE },
    unfurl: { instructions: UNFURL_INSTRUCTIONS, source: UNFURL_SOURCE },
};

/** The built-in skills, with their instructions and sources. */
const BUILT_INS: readonly ChatSkill[] = BUILT_IN_SKILLS.map((view) => {
    const prompt = Object.hasOwn(PROMPTS, view.name) ? PROMPTS[view.name] : undefined;
    const skill = {
        ...view,
        ...(prompt ? { instructions: prompt.instructions } : {}),
    };
    return {
        ...skill,
        lock: {
            ...(prompt?.source ?? { source: 'builtin' }),
            sha256: digest(skill),
        },
    };
});

export class ChatSkills implements SkillRegistryShape {
    constructor(
        private repository: WorkspaceSkillsRepository,
        private sessions?: SkillSessionsRepository,
    ) {}

    /** Every skill: the built-in ones, then the workspace's, by name. */
    async list(): Promise<ChatSkill[]> {
        const workspace = await this.repository.list();
        return [
            ...BUILT_INS,
            ...workspace.map((skill): ChatSkill => {
                const source = provenanceOf(skill);
                return {
                    name: skill.name,
                    description: skill.description,
                    kind: 'prompt',
                    mode: skill.mode,
                    builtIn: false,
                    instructions: skill.instructions,
                    updatedAt: skill.updatedAt,
                    lock: {
                        source: skill.source,
                        ...(skill.sourceUrl ? { url: skill.sourceUrl } : {}),
                        ...(skill.sourcePath ? { path: skill.sourcePath } : {}),
                        ...(skill.sourceRef ? { ref: skill.sourceRef } : {}),
                        ...(skill.sourceCommit ? { commit: skill.sourceCommit } : {}),
                        ...(source
                            ? {
                                  license: source.license,
                                  sourceSha256: source.sha256,
                                  locallyModified: !!source.locallyModified,
                              }
                            : {}),
                        sha256: skill.sha256,
                        revision: skill.revision,
                        updatedAt: skill.updatedAt,
                        updatedBy: skill.updatedBy,
                    },
                };
            }),
        ];
    }

    /**
     * The skill a turn's input invokes: its person's newest message starts
     * with one's name. An action skill only when that message is the last
     * (a turn carrying on after a tool's result runs on the model).
     */
    async invocation(messages: readonly Message[]): Promise<Invocation | undefined> {
        const at = messages.findLastIndex((message) => message.role === 'user');
        if (at < 0) {
            return undefined;
        }
        const text = messageText(messages[at].content);
        if (!skillCommand(text)) {
            return undefined;
        }
        const invoked = invokedSkill(text, await this.list());
        if (!invoked) {
            return undefined;
        }
        const latest = at === messages.length - 1;
        if (invoked.skill.kind === 'action' && !latest) {
            return undefined;
        }
        return {
            ...invoked,
            bare: invoked.bare && textOnly(messages[at]),
            latest,
        };
    }

    /**
     * The `until-done` skill `person` has on in a chat, with its current
     * content. One removed since it started, or no longer `until-done`, is
     * ended (`removed`).
     */
    async active(threadId: string, person: string): Promise<{ skill: ChatSkill; session: SkillSession } | undefined> {
        const session = await this.sessions?.active(threadId, person);
        if (!session) {
            return undefined;
        }
        const skill = (await this.list()).find((item) => item.name === session.skill && item.mode === 'until-done');
        if (skill) {
            return { skill, session };
        }
        await this.sessions?.end(threadId, person, 'removed');
        return undefined;
    }
}

/** The registry on the workspace's repositories. */
export const chatSkills = (repository: WorkspaceSkillsRepository, sessions?: SkillSessionsRepository) =>
    new ChatSkills(repository, sessions);
