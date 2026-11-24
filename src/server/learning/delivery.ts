import type { CopilotKitIntelligence } from '@copilotkit/runtime/v2';

import type { LearnedSkillsOption, SkillDeliveryShape } from './contract.js';
import type { SkillStore } from './skills.js';

/**
 * Skill delivery without Intelligence. `BuiltInAgent`'s `learnedSkills`
 * option accepts any object with `getLearnedSkillsSnapshot` (single-container
 * mode) as its `client`. It validates our snapshot (`validateSnapshot`),
 * exposes `ctx.learnedSkills.catalog` and the `copilotkit_load_skill` /
 * `copilotkit_read_skill_file` tools to the factory, and re-asks with
 * `ifNoneMatch` once its freshness window passes.
 */
export function localSkillsClient(skills: SkillStore) {
    const client = {
        async getLearnedSkillsSnapshot(request: { containerId: string; revision?: string; ifNoneMatch?: string }) {
            const snapshot = skills.snapshot(request.containerId);
            return request.ifNoneMatch === snapshot.etag
                ? {
                      status: 'unchanged' as const,
                      revision: snapshot.revision,
                      etag: snapshot.etag,
                  }
                : snapshot;
        },
    };
    // Typed as the Intelligence client class; only this method is used.
    return client as unknown as CopilotKitIntelligence;
}

/** The `learnedSkills` option for a conversation, or undefined when off. */
export function learnedSkillsFor(
    skills: SkillStore,
    deliveryEnabled: boolean | undefined,
    containerId: string | null | undefined,
): LearnedSkillsOption | undefined {
    if (!deliveryEnabled || !containerId) {
        return undefined;
    }
    return {
        client: localSkillsClient(skills),
        containerId,
        // Each turn builds a new agent, so there is no cache to keep fresh.
        freshnessWindowMs: 0,
    };
}

/**
 * Skill delivery over a workspace's published skills: what the
 * `SkillDelivery` tag holds (contract.ts). The composition root provides it
 * from this.
 */
export function skillDelivery(skills: SkillStore): SkillDeliveryShape {
    return {
        learnedSkillsFor: (deliveryEnabled, containerId) => learnedSkillsFor(skills, deliveryEnabled, containerId),
    };
}
