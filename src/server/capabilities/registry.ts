import type { DotTurn } from '@socio/foundation/turns/turn';

import type { CapabilitiesShape, CapabilityDefinition, CapabilitySection, CapabilityStatus } from './contract.js';

const ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/** The platform's capability registry (`LegacyCapabilities`). */
export class CapabilityRegistry implements CapabilitiesShape {
    private definitions = new Map<string, CapabilityDefinition>();
    private sectionMap = new Map<string, CapabilitySection>();
    register(definition: CapabilityDefinition) {
        if (!ID.test(definition.id)) {
            throw new Error(`Invalid capability id "${definition.id}".`);
        }
        if (this.definitions.has(definition.id)) {
            throw new Error(`Capability "${definition.id}" is registered twice.`);
        }
        this.definitions.set(definition.id, definition);
        return this;
    }
    section(name: string, section: CapabilitySection) {
        this.sectionMap.set(name, section);
        return this;
    }
    list() {
        return [...this.definitions.values()];
    }
    /** The capability that brings a tool, if one declares it. */
    forTool(name: string) {
        return this.list().find((definition) => definition.tools?.includes(name));
    }
    /**
     * Everything the `capabilities` tool answers for one turn. Statuses and
     * sections may be async: each is awaited in turn, so the answer's order
     * is the registry's.
     */
    async describe(turn: DotTurn, policy: (capability: string) => string, toolNames: readonly string[]) {
        const available = new Set(toolNames);
        const capabilities = [];
        for (const definition of this.list()) {
            let status: CapabilityStatus;
            try {
                status = (await definition.status?.(turn)) ?? { enabled: true };
            } catch {
                status = { enabled: false, note: 'Its status could not be read.' };
            }
            const tools = (definition.tools ?? []).filter((tool) => available.has(tool));
            capabilities.push({
                id: definition.id,
                label: definition.label,
                enabled: status.enabled && (!definition.tools?.length || !!tools.length),
                description: definition.description,
                tools,
                ...(status.note ? { note: status.note } : {}),
                ...(status.limits ? { limits: status.limits } : {}),
                ...(status.usage ? { usage: status.usage } : {}),
                ...(status.details ? { details: status.details } : {}),
                ...(definition.approvals?.length
                    ? {
                          approvals: definition.approvals.map((capability) => ({
                              capability,
                              policy: policy(capability),
                          })),
                      }
                    : {}),
            });
        }
        const sections: Record<string, unknown> = {};
        for (const [name, section] of this.sectionMap) {
            try {
                sections[name] = await section(turn);
            } catch {
                sections[name] = { error: 'Unavailable.' };
            }
        }
        return { capabilities, ...sections };
    }
}
