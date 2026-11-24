import { searches } from '@socio/foundation/search/providers';
import { computerInputs } from '@socio/shared/computers/computer-types';

import type { ComputerRecordsShape } from '../computers/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { SpaceAccessShape } from '../spaces/contract.js';
import type { ConversationsShape } from '../workspace/contract.js';

import type {
    CapabilitiesConfigShape,
    CapabilitiesShape,
    CapabilityDefinition,
    CapabilityIdentityShape,
    CapabilityRequestsShape,
} from './contract.js';
import { CapabilityRegistry } from './registry.js';

/**
 * What the core capabilities read of other features, each a slice of a
 * tag: the workspace's settings, the Spaces a reader may
 * read, a chat's socio as a reader, a socio's computer permissions, its
 * web-read capability (`CapabilityIdentity`), the Board's capability
 * requests (`CapabilityRequests`), and `CapabilitiesConfig`.
 */
export interface CoreCapabilityNeeds {
    settings: Pick<WorkspaceSettingsShape, 'settings'>;
    access: Pick<SpaceAccessShape, 'readable'>;
    conversations: Pick<ConversationsShape, 'socioReader'>;
    computers: Pick<ComputerRecordsShape, 'permissions'>;
    identity: CapabilityIdentityShape;
    requests: CapabilityRequestsShape;
    config: CapabilitiesConfigShape;
}

/**
 * The capability registry: the core ones, then each module's, in the
 * order `modules` yields them (each module's hook is called once the
 * definitions before it are registered).
 */
export function capabilityRegistry(
    needs: CoreCapabilityNeeds,
    modules: Iterable<CapabilityDefinition>,
): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    registerCoreCapabilities(registry, needs);
    for (const definition of modules) {
        registry.register(definition);
    }
    return registry;
}

/**
 * The capabilities that predate the registry (pages, computer, web
 * research, memory), plus the `identity` section (web reads) and
 * the `requests` section (capability requests).
 */
export function registerCoreCapabilities(
    registry: CapabilitiesShape,
    { settings, access, conversations, computers, identity, requests, config }: CoreCapabilityNeeds,
) {
    const computerConfigured = !!(
        config.computerSupervisorUrl?.trim() &&
        config.computerSupervisorToken?.trim() &&
        config.computerToken?.trim()
    );
    registry
        .register({
            id: 'pages',
            label: 'Space pages',
            description:
                'Find, read, create and edit Markdown pages in the Spaces this socio may use: documents the team reads. search_space_pages finds pages by their title and text; move_space_page moves one to another of its Spaces. Use review_space_page in the web chat when the user wants to see a draft first, and insert_dataset_view to embed a live table or chart of one of your datasets in a page. create_space proposes a new Space the user asked for: made once they approve it (private to them, or for the whole workspace if they are an admin), and then yours to add pages to. rename_space renames one of your Spaces when the user asks and is one of its editors; its pages and links stay.',
            tools: [
                'list_authorized_spaces',
                'list_space_pages',
                'search_space_pages',
                'read_space_page',
                'create_space_page',
                'edit_space_page',
                'move_space_page',
                'review_space_page',
                'insert_dataset_view',
                'create_space',
                'rename_space',
            ],
            // Only the Spaces it may read in this chat (CB-181): a private one
            // everyone reading it may read, never named otherwise.
            status: ({ dot, threadId }) => {
                const spaces = access.readable(conversations.socioReader(threadId, dot.id));
                return {
                    enabled: true,
                    details: {
                        defaultSpace: spaces.find((space) => space.id === dot.spaceId)?.name,
                        spaces: spaces.map((space) => space.name),
                    },
                };
            },
        })
        .register({
            id: 'computer',
            label: 'Computer',
            description:
                'This socio’s own isolated computer: a browser, workspace files and a shell. It can be stopped or destroyed at any time, so keep anything that must last in the data space (data_* and files_* tools); shell commands find a data space token in CB_DATA_TOKEN and the API in CB_DATA_URL when the operator configured it (computer_exec describes its file routes, to download a data space file and upload one; the token lasts only while that command runs; use a job for work that lasts). On a company socio’s computer, which everyone who uses the socio shares, the token reaches only the socio’s shared dataset and folder, which everyone who uses it can see, and datasets shared with a Space, read-only; never a person’s own data (CB-227).',
            tools: Object.keys(computerInputs)
                .filter((name) => !name.startsWith('human_'))
                .map((name) => `computer_${name}`),
            status: async ({ dot }) => {
                const permissions = await computers.permissions(dot.id);
                return {
                    enabled: computerConfigured && permissions.enabled,
                    ...(computerConfigured
                        ? permissions.enabled
                            ? {}
                            : {
                                  note: 'An admin enables it in the socio’s computer permissions.',
                              }
                        : { note: 'No computer service is configured.' }),
                    details: computerConfigured ? { permissions } : undefined,
                };
            },
        })
        .register({
            id: 'web.research',
            label: 'Web research',
            description: 'Search public web sources and read public pages, citing their URLs.',
            tools: ['search_web', 'read_public_page'],
            status: ({ dot }) => {
                const allowed = dot.researchAllowed && settings.settings().researchAllowed;
                return {
                    enabled: allowed && searches(config),
                    ...(allowed
                        ? {}
                        : {
                              note: 'Research is turned off for this socio or the workspace.',
                          }),
                };
            },
        })
        .register({
            id: 'memory',
            label: 'Memory',
            description:
                'The person’s profile and the memories they approved (Memories), the ones that bear on their message given with it each turn; in a chat with other people, only what they chose to share with team chats. propose_memory suggests a new memory, used once they approve it; one they ask for about themselves, in their own chat, is saved at once. In the person’s own chats, search_episodes finds what happened in their earlier ones (decisions, results, what a chat was about); never in a chat with other people in it. Shared knowledge of the socio’s Spaces that every reader of the chat can read comes with matching messages; propose_space_memory proposes an entry or a change, used once one of the Space’s editors approves it.',
            tools: ['propose_memory', 'search_episodes', 'propose_space_memory'],
            status: ({ dot }) => ({
                enabled: dot.memoryAllowed && settings.settings().memoryAllowed,
            }),
        })
        // The Dot's web identity, limits and the hosts that asked it to stop.
        .section('identity', ({ dot }) => identity.capabilityFor(dot.id))
        // This Dot's capability requests for this user.
        .section('requests', async ({ dot, userId }) => ({
            note: 'Use request_capability when you need something no tool here can do; requests go to the workspace tracker.',
            pending: await requests.pendingRequestsFor(dot.id, userId),
            resolved: await requests.resolvedRequestsFor(dot.id, userId),
        }));
}
