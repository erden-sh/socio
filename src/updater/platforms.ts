import type { UpdaterConfig } from './config.js';
import type { HealthGateOptions } from './health.js';
import { UPDATER_PLATFORMS, type UpdaterPlatform } from './platform.js';
import { PortainerPlatform } from './portainer-platform.js';
import { PortainerClient } from './portainer.js';

export interface PlatformOptions extends HealthGateOptions {
    /** The platform API's transport (tests: a loopback fake). */
    platformTransport?: typeof fetch;
}

/**
 * The adapter `UPDATER_PLATFORM` names (CB-323). `updaterConfigFromEnv`
 * already refuses an unknown one; this refuses it again for a config built
 * by hand.
 */
export function createPlatform(config: UpdaterConfig, options: PlatformOptions = {}): UpdaterPlatform {
    const { platformTransport, ...health } = options;
    switch (config.platform) {
        case 'portainer':
            return new PortainerPlatform(config, new PortainerClient(config.portainer, platformTransport), health);
        default:
            throw new Error(
                `The updater has no "${String(config.platform)}" platform: UPDATER_PLATFORM must be ${UPDATER_PLATFORMS.join(' or ')}.`,
            );
    }
}
