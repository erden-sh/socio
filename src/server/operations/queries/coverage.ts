import { Context } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { MODULE_IDS } from '@socio/shared/modules';
import type { OpsCoverage, OpsCoverageTool, OpsToolUse } from '@socio/shared/operations/operations-knowledge';
import type { Dot } from '@socio/shared/types';

import { CAPABILITIES_TOOL, type CapabilitiesShape } from '../../capabilities/contract.js';
import type { ModuleContext, ServerModule } from '../../modules/contract.js';
import { WorkspaceSettings } from '../../settings/contract.js';
import { Conversations, Socios, Spaces } from '../../workspace/contract.js';

/** What the coverage matrix reads: the platform's modules, their context and the registry. */
export interface CoverageSources {
    /**
     * The modules' Effect hooks may need any of the app's services; this
     * only hands the context on to their `dotTools`, so it needn't name them.
     */
    // oxlint-disable-next-line typescript/no-explicit-any -- see above
    modules: readonly ServerModule<any>[];
    context: ModuleContext;
    capabilities: Pick<CapabilitiesShape, 'list' | 'forTool'>;
}

/**
 * The platform's modules and the context their hooks get, for the coverage
 * matrix: the composition provides them, as it hands them to the
 * module runner.
 */
export class CoverageModules extends Context.Service<CoverageModules, Pick<CoverageSources, 'modules' | 'context'>>()(
    'socio/operations/CoverageModules',
) {}

/** The module the `capabilities` tool itself belongs to: the platform's. */
const PLATFORM = 'platform';
const COVERAGE_ID = 'operations-coverage';

/**
 * The socio tools each module gives (CB-191): every module's `dotTools`
 * for a turn of a made-up socio with every permission, the workspace's
 * own switches (research, memory) on, so the list is everything a socio
 * could be given in this deployment; what a missing service holds back
 * (a computer, say) stays out. Tools are only defined, never run: the
 * turn's `check` refuses and its signal is aborted.
 */
export function offeredTools(sources: CoverageSources) {
    const { context, modules } = sources;
    const { services } = context;
    const spaces = services.get(Spaces).spaces();
    const dot: Dot = {
        id: COVERAGE_ID,
        spaceId: spaces[0]?.id ?? '',
        spaceIds: spaces.map((space) => space.id),
        name: 'Coverage',
        instructions: '',
        researchAllowed: true,
        memoryAllowed: true,
        issuesAllowed: true,
        createdAt: 0,
        ownerId: null,
    };
    const names: string[] = [];
    const turn: DotTurn = {
        dot,
        userId: COVERAGE_ID,
        threadId: COVERAGE_ID,
        channel: false,
        purpose: 'chat',
        check: () => {
            throw new Error('The coverage matrix runs no tools.');
        },
        signal: AbortSignal.abort(),
        toolNames: () => names,
    };
    // Read-only views with the made-up socio's answers in them, as the
    // modules' hooks read them (the workspace's settings, chats and socios);
    // everything else is the app's services.
    const settings = services.get(WorkspaceSettings);
    const conversations = services.get(Conversations);
    const socios = services.get(Socios);
    const overrides = new Map<unknown, object>([
        [
            WorkspaceSettings,
            overriding(settings, {
                settings: () => ({
                    ...settings.settings(),
                    researchAllowed: true,
                    memoryAllowed: true,
                }),
            }),
        ],
        [
            Conversations,
            overriding(conversations, {
                requireThread: (id: string, dotId?: string) =>
                    id === COVERAGE_ID
                        ? {
                              id,
                              dotId: dot.id,
                              ownerId: COVERAGE_ID,
                              title: '',
                              createdAt: 0,
                          }
                        : conversations.requireThread(id, dotId),
            }),
        ],
        [Socios, overriding(socios, { dot: (id: string) => (id === dot.id ? dot : socios.dot(id)) })],
    ]);
    const ctx: ModuleContext = {
        ...context,
        services: {
            get: (tag) => (overrides.get(tag) ?? services.get(tag)) as never,
            run: services.run,
        },
    };
    const tools = new Map<string, string>([[CAPABILITIES_TOOL, PLATFORM]]);
    const unlisted: string[] = [];
    for (const module of modules) {
        let given;
        try {
            given = module.dotTools?.(ctx, turn) ?? [];
        } catch {
            // It needs more of a real turn to list its tools: shown as unlisted.
            unlisted.push(module.id);
            continue;
        }
        for (const tool of given) {
            if (!tools.has(tool.name)) {
                tools.set(tool.name, module.id);
            }
        }
        names.push(...given.map((tool) => tool.name));
    }
    return { tools, unlisted };
}

/** `target`, with some of its methods answered by `methods` instead. */
function overriding<T extends object>(target: T, methods: Partial<T>): T {
    return new Proxy(target, {
        get(object, key) {
            if (Object.hasOwn(methods, key)) {
                return methods[key as keyof T];
            }
            const value: unknown = Reflect.get(object, key, object);
            return typeof value === 'function' ? value.bind(object) : value;
        },
    });
}

/**
 * The coverage matrix (CB-191): `MODULE_IDS` × the tools each module
 * gives × the capability registry, with each tool's calls in the range.
 * A tool no registry entry declares is a gap (`unregistered`); one an
 * entry declares that nothing gives here is `unoffered`. The
 * `capabilities` tool is the registry's own and counts as covered.
 */
export function capabilityCoverage(sources: CoverageSources, use: readonly OpsToolUse[]): OpsCoverage {
    const { tools: offered, unlisted } = offeredTools(sources);
    const registry = sources.capabilities.list();
    const calls = new Map(use.map((row) => [row.tool, row]));
    const names = new Set([
        ...offered.keys(),
        ...registry.flatMap((definition) => definition.tools ?? []),
        ...calls.keys(),
    ]);
    const tools = [...names].sort().map((name): OpsCoverageTool => ({
        name,
        module: offered.get(name) ?? null,
        capability: sources.capabilities.forTool(name)?.id ?? null,
        offered: offered.has(name),
        calls: calls.get(name)?.calls ?? 0,
        errors: calls.get(name)?.errors ?? 0,
    }));
    const moduleIds = [...new Set([...Object.values(MODULE_IDS), ...sources.modules.map((module) => module.id)])];
    return {
        modules: [PLATFORM, ...moduleIds].map((id) => ({
            id,
            tools: tools.filter((tool) => tool.module === id).length,
            listed: !unlisted.includes(id),
        })),
        capabilities: registry.map((definition) => ({
            id: definition.id,
            label: definition.label,
            tools: definition.tools?.length ?? 0,
            offered: (definition.tools ?? []).filter((tool) => offered.has(tool)).length,
            approvals: [...(definition.approvals ?? [])],
        })),
        tools,
        unregistered: tools
            .filter((tool) => tool.offered && !tool.capability && tool.name !== CAPABILITIES_TOOL)
            .map((tool) => tool.name),
        unoffered: tools.filter((tool) => tool.capability && !tool.offered).map((tool) => tool.name),
    };
}
