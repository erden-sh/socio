import type { UpdaterConfig } from './config.js';
import { waitForHealth, type HealthGateOptions } from './health.js';
import { imagesFor, onlyTagsChanged, planEnv, PlanError } from './plan.js';
import type { PreparedDeploy, UpdaterPlatform } from './platform.js';
import { PortainerClient, type StackEnvEntry } from './portainer.js';

/** What a Portainer deploy keeps to resume or roll back. */
export interface PortainerDeployment {
    stackId: number;
    /** The stack before the update: its file and every env entry. */
    previous: { file: string; env: StackEnvEntry[] };
    /** The env sent for the update: the same, with the tag keys changed. */
    next: StackEnvEntry[];
}

/**
 * The `portainer` adapter (CB-259, a port since CB-323): through the
 * Portainer stack API only. It reads the stack, keeps its file and every
 * env entry, sets only the tag keys to the release, checks the images are
 * on the node, and updates the stack; a rollback sends the previous file
 * and env back. Health is the app's own `/healthz` gate.
 */
export class PortainerPlatform implements UpdaterPlatform<PortainerDeployment> {
    readonly name = 'portainer' as const;

    constructor(
        private config: UpdaterConfig,
        private client: PortainerClient = new PortainerClient(config.portainer),
        private health: HealthGateOptions = {},
    ) {}

    get describe() {
        const { stack, tagKeys, portainer } = this.config;
        return `stack ${stack} (${tagKeys.join(', ')}) on Portainer endpoint ${portainer.endpointId}`;
    }

    async prepare(target: string): Promise<PreparedDeploy<PortainerDeployment>> {
        const { config, client } = this;
        const stack = await client.findStack(config.stack);
        const file = await client.stackFile(stack.id);
        const next = planEnv(stack.env, config.tagKeys, target);
        if (!onlyTagsChanged(stack.env, next, config.tagKeys)) {
            throw new PlanError('The planned env changes more than the tag keys.');
        }
        if (!config.pullImage) {
            for (const image of imagesFor(file, config.tagKeys, target)) {
                if (!(await client.imageExists(image))) {
                    throw new PlanError(
                        `${image} is not on the node: build it on the node first (scripts/build-images.mjs), or set UPDATER_PULL_IMAGE=true for a registry.`,
                    );
                }
            }
        }
        return {
            state: { stackId: stack.id, previous: { file, env: stack.env }, next },
            summary: `setting ${config.tagKeys.join(', ')} to ${target} on stack ${config.stack}; every other env entry stays.`,
        };
    }

    async deploy(state: PortainerDeployment) {
        await this.client.updateStack(state.stackId, {
            file: state.previous.file,
            env: state.next,
            pullImage: this.config.pullImage,
        });
    }

    async deployed(state: PortainerDeployment) {
        const { env } = await this.client.stack(state.stackId);
        return !this.config.tagKeys.every(
            (key) =>
                env.find((entry) => entry.name === key)?.value ===
                state.previous.env.find((entry) => entry.name === key)?.value,
        );
    }

    waitHealthy(version: string) {
        return waitForHealth(this.config.health, version, this.health);
    }

    async rollBack(state: PortainerDeployment) {
        await this.client.updateStack(state.stackId, {
            file: state.previous.file,
            env: state.previous.env,
            pullImage: false,
        });
    }
}
