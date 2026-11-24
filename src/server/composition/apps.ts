import { Context, Effect, Layer } from 'effect';

/**
 * Mini apps' construction: the apps layer (`apps/layer.ts`) wired into the
 * graph at the step the server has always built it at. The computers are built
 * later: apps reach them through their port.
 */
import { Apps, AppsConfig, type AppsConfigShape } from '../apps/contract.js';
import { AppsBoot, appsService } from '../apps/layer.js';
import { AppsServiceTag } from '../apps/tags.js';
import { Spaces } from '../workspace/contract.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { Ports } from './ports.js';

/**
 * `AppsConfig` from the supplied startup configuration (`PlatformConfig`;
 * moving env parsing here is a later change).
 */
export const appsConfig = (config: PlatformConfig): AppsConfigShape => ({
    apps: config.apps,
    appsRuntime: config.appsRuntime,
    appLogs: config.appLogs,
    dataApiUrl: config.data?.apiUrl,
    sessionSecret: config.sessionSecret,
});

/** Mini apps, under the graph's `LegacyApps` tag (the class): apps' own tag. */
export { AppsServiceTag as LegacyApps };

/**
 * Mini apps' step of the graph: the apps layer's registry, offered as
 * `Apps` and `LegacyApps`, with `AppsConfig` built from the supplied
 * config. Its boot (`AppsBoot`) is the workspace connection and the
 * computers' port. The settings' tags and the computers' bridges
 * (`ComputerRecords`, `Screenshots`) are leaf bridges, built before every
 * step.
 */
export const appsLayers = {
    apps: Layer.effectContext(
        Effect.gen(function* () {
            const config = AppsConfig.of(appsConfig(yield* LegacyConfig));
            const ports = yield* Ports;
            const workspace = yield* LegacyWorkspace;
            const boot = AppsBoot.of({ db: workspace.db, computers: () => ports.computers.get() });
            // `Spaces` as the boot step's store, which forwards to the very
            // slice the root's `Spaces` holds: the Space-access listener is
            // registered through the store, as the constructor does.
            const apps = yield* appsService.pipe(
                Effect.provideService(AppsConfig, config),
                Effect.provideService(AppsBoot, boot),
                Effect.provideService(Spaces, workspace),
            );
            return Context.make(AppsServiceTag, apps).pipe(Context.add(Apps, apps), Context.add(AppsConfig, config));
        }),
    ),
};
