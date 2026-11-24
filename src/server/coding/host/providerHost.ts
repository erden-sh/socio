import { DEFAULT_SERVER_SETTINGS, type ServerSettings, ServerSettingsError } from '@t3tools/contracts';
import { ProviderCredentialError } from '@t3tools/provider-core/server/errors';
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';

/**
 * Socio's `ProviderHost` for the coding session host (CB-326 step 2): the seams
 * where T3 Code's vendored provider drivers meet Socio's services, run inside
 * each coding sandbox.
 *
 * T3's `ProviderHost` (provider-core) gives a driver the sandbox's paths,
 * settings, attachments and stored credentials. Socio supplies the sandbox's
 * own paths and attachment resolution; the model gateway replaces T3's model
 * providers, so the drivers we wire (provider-grok, provider-opencode,
 * provider-pi, provider-acp-registry, and a Socio provider-codex over
 * effect-codex-app-server) use only `paths.cwd` and `resolveAttachmentPath`.
 * They do not read `settings`, so it returns the schema's default and never
 * changes; `shouldRunBackgroundWork` stays false (the session host runs work
 * synchronously per turn). `credentials` is backed by Socio Secrets and is
 * filled in for subscription logins in CB-326 step 5; for the gateway route
 * it is unused (the session's `cbgw_` reaches the gateway, never a vendor
 * login), so it returns an empty credential until then.
 */

export interface SocioProviderHostPaths {
    /** The sandbox's working directory (the repository checkout). */
    readonly cwd: string;
    /** The sandbox's writable state directory. */
    readonly stateDir: string;
    /** Where chat attachments live, if the session has any. */
    readonly attachmentsDir: string;
}

const notImplementedSettings = {
    get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    // The drivers Socio wires never call withSnapshot/changes/subscribe; the
    // session host owns its own turns. These satisfy the interface with the
    // schema's default and an empty stream.
    withSnapshot: <A, E, R>(use: (settings: ServerSettings) => Effect.Effect<A, E, R>) =>
        use(DEFAULT_SERVER_SETTINGS) as Effect.Effect<A, E | ServerSettingsError, R>,
    changes: Stream.empty,
    subscribe: Effect.succeed(Stream.empty),
};

/**
 * Builds the `ProviderHost` service value for one session's sandbox. It is
 * wrapped in `Layer.succeed` by `providerHostLayer`.
 */
export const socioProviderHostValue = (paths: SocioProviderHostPaths) =>
    ProviderHost.ProviderHost.of({
        paths: {
            cwd: paths.cwd,
            baseDir: paths.stateDir,
            stateDir: paths.stateDir,
            providerStatusCacheDir: `${paths.stateDir}/provider-status`,
            attachmentsDir: paths.attachmentsDir,
        },
        settings: notImplementedSettings,
        shouldRunBackgroundWork: () => Effect.succeed(false),
        resolveAttachmentPath: () => null,
        credentials: () =>
            Effect.succeed({
                binding: { owner: 't3', key: 'socio-empty' },
                get: Effect.succeed(Option.none()),
                set: () => Effect.die('setting provider credentials is not supported on the gateway route'),
                remove: Effect.die('removing provider credentials is not supported on the gateway route'),
            }),
    });

/** A `ProviderHost` layer for one session's sandbox. */
export const providerHostLayer = (paths: SocioProviderHostPaths) =>
    Layer.succeed(ProviderHost.ProviderHost, socioProviderHostValue(paths));

// Re-export the error type and the option for the credentials seam (CB-326 step 5).
export { ProviderCredentialError, Option };
