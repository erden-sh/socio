import { CodexSettings, ProviderDriverKind } from '@t3tools/contracts';
import * as CodexClient from 'effect-codex-app-server/client';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Scope from 'effect/Scope';

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from '@t3tools/provider-core/server/driver';

import { makeAdapter } from './adapter.ts';

/**
 * Socio's Codex `ProviderDriver` (CB-326): a Codex provider instance run
 * by the session host over `codex app-server` (the
 * `effect-codex-app-server` JSON-RPC client), reaching models only through
 * Socio's gateway (base URL + the `with-token` auth command from
 * `gatewayAuth.ts`), instead of T3's `CodexAdapterV2` extraction.
 *
 * `create()` starts the `CodexAppServerClient` (a stdio child running
 * `codex app-server` with the gateway as its only model provider), builds
 * the orchestration adapter over it, and returns the `ProviderInstance`. The
 * textGeneration and managed snapshot follow; this slice lands the driver
 * skeleton + the adapter so step 3 can open a session.
 */

export const CODEX_DRIVER_KIND = ProviderDriverKind.make('codex');

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** The Effect services the Codex driver needs from the host. */
export type CodexDriverEnv = CodexClient.CodexAppServerClient;

/** The default config: managed setup, the gateway route built by the host. */
const defaultConfig = (): CodexSettings => decodeCodexSettings({});

/**
 * The Codex driver. The `create` Effect requires a `CodexAppServerClient`
 * (started by the session host over stdio to `codex app-server`) and a Scope;
 * the host provides both per session.
 */
export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  metadata: {
    displayName: 'Codex',
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig,
  create: Effect.fn('CodexDriver.create')(
    function* (input: {
      readonly instanceId: Parameters<typeof defaultProviderContinuationIdentity>[0]['instanceId'];
      readonly displayName: string | undefined;
      readonly accentColor?: string | undefined;
      readonly enabled: boolean;
      readonly config: CodexSettings;
    }) {
      const client = yield* CodexClient.CodexAppServerClient;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: CODEX_DRIVER_KIND,
        instanceId: input.instanceId,
      });
      const orchestrationAdapter = yield* makeAdapter({
        instanceId: input.instanceId,
        client,
      });
      // textGeneration and the managed snapshot land in the next slice; the
      // adapter's openSession is the seam step 3 drives. A minimal snapshot
      // keeps the ProviderInstance shape honest until status.ts is ported.
      const snapshot = {
        getSnapshot: Effect.succeed({
          driver: CODEX_DRIVER_KIND,
          providerInstanceId: input.instanceId,
          installed: input.enabled,
          auth: { status: 'authenticated' },
        } as never),
      } as never;
      return {
        instanceId: input.instanceId,
        driverKind: CODEX_DRIVER_KIND,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: { generate: () => Effect.die('textGeneration: not wired yet') } as never,
      } satisfies ProviderInstance;
    },
  ),
};

export { CodexClient, Effect, Scope };
