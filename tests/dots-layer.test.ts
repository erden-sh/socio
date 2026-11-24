// The socios' layer builds the extensions every DotAgent gets from other
// features' tags and the root's hooks, and the agents over them; the
// composition's step offers them under the legacy tag too, with `DotsConfig`
// from the supplied config.
import { Context, Effect, Layer } from 'effect';
import { expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { Apps, type AppsShape } from '../src/server/apps/contract.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { Data, DataConfig, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import {
    DotAgents,
    DotTurnHooks,
    TurnExtensions,
    type DotTurnHooksShape,
    type DotTurnServices,
} from '../src/server/dots/contract.js';
import { DotAgentFactoryCore } from '../src/server/dots/dot-agent.js';
import { DotAgentsLive, dotExtensions, TurnExtensionsLive } from '../src/server/dots/layer.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { Media, type MediaShape } from '../src/server/media/contract.js';
import { Orchestrator, type OrchestratorShape } from '../src/server/rooms/contract.js';
import { Runner, type RunnerShape } from '../src/server/turns/contract.js';

import type { Store } from './helpers/stores.js';

const turn = { userId: 'carol', dotId: 'dot-1', threadId: 't-1' } as unknown as DotTurn;

function sources() {
    const hooks: DotTurnHooksShape = {
        tools: vi.fn(() => []),
        toolsOff: vi.fn(() => new Set(['web_read'])),
        pageContext: vi.fn(() => 'page'),
        news: vi.fn(() => 'news'),
        turnNote: vi.fn(async () => 'note'),
    };
    const refRecorder = vi.fn();
    const tokens = { revokeDot: vi.fn(), commandTokens: vi.fn(() => ['tok-c']) };
    const data = { computerEnv: vi.fn(() => undefined), tokens };
    const apps = { computerStopped: vi.fn(), secretsFor: vi.fn(() => ['tok-a']) };
    const media = { resolveForModel: vi.fn(async () => []), toolImageSource: vi.fn() };
    const orchestrator = { readsMidTurn: vi.fn(() => true) };
    return { hooks, refRecorder, tokens, data, apps, media, orchestrator };
}

it('builds the extensions from the slices, calling each source as before', async () => {
    const s = sources();
    const extensions = dotExtensions({
        hooks: s.hooks,
        runner: { refRecorder: s.refRecorder },
        data: s.data as unknown as DataSpaceShape,
        dataApiUrl: 'http://data:8080',
        apps: s.apps,
        media: s.media as unknown as MediaShape,
        orchestrator: s.orchestrator,
    });
    extensions.runRefs?.('run-1', 't-1');
    expect(s.refRecorder).toHaveBeenCalledWith('run-1', 't-1');
    expect(extensions.toolsOff?.(turn)).toEqual(new Set(['web_read']));
    expect(await extensions.turnNote?.(turn)).toBe('note');
    extensions.computer?.execEnv?.('dot-1', 'carol', 5000);
    expect(s.data.computerEnv).toHaveBeenCalledWith('dot-1', 'carol', 'http://data:8080', 5000);
    extensions.computer?.stopped?.('dot-1');
    expect(s.tokens.revokeDot).toHaveBeenCalledWith('dot-1', ['computer', 'job']);
    expect(s.apps.computerStopped).toHaveBeenCalledWith('dot-1');
    // Mini apps' tokens first, then the live commands'.
    expect(extensions.computer?.secrets?.('dot-1')).toEqual(['tok-a', 'tok-c']);
    expect(extensions.readsMidTurn?.('t-1', 'dot-1', 'hi')).toBe(true);
});

it('offers the extensions and DotAgents over the tags', async () => {
    const s = sources();
    const inference = { resolve: vi.fn() } as unknown as InferenceShape;
    const tags = Layer.mergeAll(
        Layer.succeed(DotTurnHooks, s.hooks),
        Layer.succeed(Runner, { refRecorder: s.refRecorder } as unknown as RunnerShape),
        Layer.succeed(Data, s.data as unknown as DataSpaceShape),
        Layer.succeed(DataConfig, { data: { apiUrl: 'http://data:8080' } } as never),
        Layer.succeed(Apps, s.apps as unknown as AppsShape),
        Layer.succeed(Media, s.media as unknown as MediaShape),
        Layer.succeed(Orchestrator, s.orchestrator as unknown as OrchestratorShape),
        Layer.succeed(Inference, inference),
    );
    const layer = DotAgentsLive({} as DotTurnServices, {} as Store, {} as WorkspaceStore, {} as PlatformConfig).pipe(
        Layer.provideMerge(TurnExtensionsLive),
        Layer.provide(tags),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const extensions = Context.get(context, TurnExtensions);
    extensions.computer?.execEnv?.('dot-1', undefined, 1);
    expect(s.data.computerEnv).toHaveBeenCalledWith('dot-1', undefined, 'http://data:8080', 1);
    const agents = Context.get(context, DotAgents);
    expect(agents).toBeInstanceOf(DotAgentFactoryCore);
});
