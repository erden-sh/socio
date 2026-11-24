// Telegram's layers and the composition's step: `Links` over the workspace's
// links store, `TelegramConfig` from the process's config, and
// `ChannelServices` from the other features' tags, which the boot step reads
// to make the channel.
import { Context, Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import type { SetupStatus } from '@socio/shared/types';

import { LegacyConfig, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { platformPorts, Ports } from '../src/server/composition/ports.js';
import { telegramConfig, telegramLayers } from '../src/server/composition/telegram.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { DotReplies, Reactions, type DotRepliesShape, type ReactionsShape } from '../src/server/context/contract.js';
import { DotAgents, type DotAgentsShape } from '../src/server/dots/contract.js';
import { MemoryItems, type MemoryRepository } from '../src/server/memory/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { SkillRegistry, type SkillRegistryShape } from '../src/server/skills/contract.js';
import { Links, TelegramConfig } from '../src/server/telegram/contract.js';
import { ChannelServices, ChannelServicesLive, LinksLive } from '../src/server/telegram/layer.js';
import type { TelegramWorkspace } from '../src/server/telegram/slices.js';
import { TelegramHost } from '../src/server/telegram/tags.js';

const agents = { agent: () => undefined as never } as DotAgentsShape;
const skills = { list: async () => [] } as unknown as SkillRegistryShape;
const reactions = {} as ReactionsShape;
const replies = { find: async () => undefined } as DotRepliesShape;
const memoryItems = {} as MemoryRepository;
let paused = false;
const settings = { settings: () => ({ paused }) } as unknown as WorkspaceSettingsShape;
const links = { linkFor: async () => undefined };
const workspace = { telegram: links } as unknown as WorkspaceStore;

/** The other features' tags the channel's services yield. */
const tags = Layer.mergeAll(
    Layer.succeed(DotAgents, agents),
    Layer.succeed(SkillRegistry, skills),
    Layer.succeed(Reactions, reactions),
    Layer.succeed(DotReplies, replies),
    Layer.succeed(MemoryItems, memoryItems),
    Layer.succeed(WorkspaceSettings, settings),
);

it('offers ChannelServices from the other features’ tags', async () => {
    const layer = ChannelServicesLive(Effect.succeed(workspace as unknown as TelegramWorkspace)).pipe(
        Layer.provide(tags),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const services = Context.get(context, ChannelServices);
    expect(services.agents).toBe(agents);
    expect(services.skills).toBe(skills);
    expect(services.reactions).toBe(reactions);
    expect(services.replies).toBe(replies);
    expect(services.workspace).toBe(workspace);
    expect(services.store.memoryItems).toBe(memoryItems);
    // The settings are read at each use: a pause counts at once.
    expect(services.store.settings().paused).toBe(false);
    paused = true;
    expect(services.store.settings().paused).toBe(true);
    paused = false;
});

it('offers the links it is given as Links', async () => {
    const context = await Effect.runPromise(Layer.build(LinksLive(links as never)).pipe(Effect.scoped));
    expect(Context.get(context, Links)).toBe(links);
});

it('reads TelegramConfig from the process’s config, not the environment', () => {
    expect(telegramConfig({ appOrigin: 'https://socio.example' })).toEqual({ appOrigin: 'https://socio.example' });
    expect(telegramConfig({})).toEqual({ appOrigin: undefined });
});

it('builds the graph’s links step: the workspace’s links, as Links', async () => {
    const layer = telegramLayers.links.pipe(Layer.provide(Layer.succeed(LegacyWorkspace, workspace)));
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, Links)).toBe(links);
});

it('builds the graph’s step: its ChannelServices for the boot step, and TelegramHost over the late ports', async () => {
    const ports = platformPorts();
    const layer = telegramLayers.bridges.pipe(
        Layer.provide(
            Layer.mergeAll(
                tags,
                Layer.succeed(LegacyWorkspace, workspace),
                Layer.succeed(LegacyConfig, { appOrigin: 'https://socio.example' } as PlatformConfig),
                Layer.succeed(Ports, ports),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, TelegramConfig)).toEqual({ appOrigin: 'https://socio.example' });
    // The boot step reads it from the built services (`AppEdge.services`).
    const services = Context.get(context, ChannelServices);
    expect(services.workspace).toBe(workspace);
    expect(services.agents).toBe(agents);
    // The hooks' host reads the channel and the setup status at each use.
    const host = Context.get(context, TelegramHost);
    expect(host.channel).toBeUndefined();
    expect(() => host.setup('u1')).toThrow('The late-bound port "setup" was read before it was filled.');
    const status = { ready: true } as unknown as SetupStatus;
    const asked: Array<string | undefined> = [];
    ports.setup.fill({
        setup: async (userId) => {
            asked.push(userId);
            return status;
        },
    });
    await expect(host.setup('u1')).resolves.toBe(status);
    expect(asked).toEqual(['u1']);
});
