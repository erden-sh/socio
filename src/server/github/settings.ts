import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import type { SecretBox } from '@socio/foundation/keys/secret-box';
import { renamedSetting } from '@socio/foundation/settings/renamed-setting';
import { GITHUB_REPOSITORY, type GitHubAppInput, type GitHubAppView } from '@socio/shared/github-types';

import type { FlowPhase, GitHubAppConfig, GitHubAppCredentials, GitHubAdminShape, GitHubAppEnv } from './contract.js';
import type { GitHubSettingsRepository } from './infra/store.js';

const NUMERIC_ID = /^[1-9]\d{0,18}$/;

/**
 * The settings' names before CB-325, when they were dispatch's: each old
 * name is still read for one release when the new one is unset, with a
 * one-line deprecation warning. Remove the fallback in the release after.
 */
export const DEPRECATED_GITHUB_ENV = {
    GITHUB_APP_ID: 'DISPATCH_GITHUB_APP_ID',
    GITHUB_APP_PRIVATE_KEY: 'DISPATCH_GITHUB_APP_PRIVATE_KEY',
    GITHUB_INSTALLATION_ID: 'DISPATCH_GITHUB_INSTALLATION_ID',
    GITHUB_REPO: 'DISPATCH_GITHUB_REPO',
} as const;

/**
 * `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `_FILE`; a PEM, `\n`
 * escapes allowed), `GITHUB_INSTALLATION_ID` and `GITHUB_REPO`
 * (`owner/name`), each also read under its old `DISPATCH_GITHUB_*` name for
 * one release. An admin's "Connect GitHub" in Settings takes their place.
 * Malformed values stop startup without echoing the key.
 */
export function gitHubAppFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void = (line) => console.warn(line),
): GitHubAppEnv {
    const read = (name: keyof typeof DEPRECATED_GITHUB_ENV) =>
        renamedSetting(env, name, DEPRECATED_GITHUB_ENV[name], warn);
    const id = read('GITHUB_APP_ID');
    const key = read('GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n');
    const installationId = read('GITHUB_INSTALLATION_ID');
    const repository = read('GITHUB_REPO');
    if (!id !== !key) {
        throw new Error('Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or neither.');
    }
    if (id && !NUMERIC_ID.test(id)) {
        throw new Error('GITHUB_APP_ID must be the App’s number.');
    }
    if (key && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
        throw new Error('GITHUB_APP_PRIVATE_KEY must be the App’s private key (PEM).');
    }
    if (installationId && !NUMERIC_ID.test(installationId)) {
        throw new Error('GITHUB_INSTALLATION_ID must be a number.');
    }
    if (repository && !GITHUB_REPOSITORY.test(repository)) {
        throw new Error('GITHUB_REPO must be owner/name.');
    }
    return {
        app: id && key ? { id, privateKey: key } : undefined,
        installationId,
        repository,
    };
}

/** The saved App could not be opened: its data key is gone. */
export class SealedAppError extends Error {}

/** A connect step's state did not match: expired, used, or not this admin's. */
export class FlowStateError extends Error {}

const KEYS = {
    app: 'github.app',
    installation: 'github.installation',
    repository: 'github.repository',
    flow: 'github.flow',
} as const;

/** The App as stored: sealed, key and all. */
interface StoredApp {
    id: string;
    slug: string;
    owner: string;
    privateKey: string;
}

interface StoredFlow {
    hash: string;
    userId: string;
    phase: FlowPhase;
    owner: string;
    expiresAt: number;
}
const FLOW_MS = 60 * 60 * 1000;
const hash = (state: string) => createHash('sha256').update(state).digest('hex');

/**
 * The GitHub App coding sessions use (CB-32, CB-239), as an admin set it in
 * Settings over the environment's: the repository whose owner gets the App,
 * the App made by "Connect GitHub" (its private key sealed under the data
 * key) and its installation, and the connect flow's one-time state. Only
 * this class reads or writes these rows (`infra/store.ts`); the key leaves it
 * only to sign the App's JWTs.
 */
export class GitHubAppSettings implements GitHubAdminShape {
    constructor(
        private uow: UnitOfWork,
        private settings: GitHubSettingsRepository,
        private box: SecretBox,
        private env: GitHubAppEnv = {},
        private now: () => number = () => Date.now(),
    ) {}

    private read(key: string) {
        return this.settings.get(key);
    }

    private write(key: string, value: string | null) {
        return value === null ? this.settings.remove(key) : this.settings.set(key, value);
    }

    private async storedApp(): Promise<StoredApp | undefined> {
        const sealed = await this.read(KEYS.app);
        if (!sealed) {
            return undefined;
        }
        try {
            return this.box.open(sealed) as StoredApp;
        } catch {
            throw new SealedAppError(
                'The GitHub App saved in Settings can’t be opened (its data key is gone); select Disconnect there, then Connect GitHub.',
            );
        }
    }

    /** What admins see; never the key. `canConnect` is the caller's. */
    async view(canConnect: boolean): Promise<GitHubAppView> {
        const repository = await this.read(KEYS.repository);
        let saved: StoredApp | undefined;
        let unreadable = false;
        try {
            saved = await this.storedApp();
        } catch {
            unreadable = true;
        }
        const app = saved
            ? {
                  source: 'settings' as const,
                  id: saved.id,
                  slug: saved.slug,
                  owner: saved.owner,
              }
            : this.env.app && !unreadable
              ? {
                    source: 'env' as const,
                    id: this.env.app.id,
                    slug: null,
                    owner: null,
                }
              : null;
        const installation = saved ? await this.read(KEYS.installation) : this.env.installationId;
        const repo = repository ?? this.env.repository ?? null;
        return {
            repository: repo,
            repositorySource: repository ? 'settings' : this.env.repository ? 'env' : null,
            app,
            installation: installation
                ? {
                      id: installation,
                      account: saved ? saved.owner : null,
                  }
                : null,
            unreadable,
            canConnect,
        };
    }

    /**
     * The values in force, the key opened: the App connected here, else the
     * environment's (each with its own installation id). Throws
     * `SealedAppError` when the saved App can't be opened.
     */
    async inForce(): Promise<GitHubAppConfig> {
        const saved = await this.storedApp();
        return {
            app: saved ? { id: saved.id, privateKey: saved.privateKey } : this.env.app,
            installationId: saved ? await this.read(KEYS.installation) : this.env.installationId,
            repository: (await this.read(KEYS.repository)) ?? this.env.repository,
        };
    }

    /** The repository; validated by the route. */
    async save(input: GitHubAppInput) {
        if (input.repository !== undefined) {
            await this.write(KEYS.repository, input.repository);
        }
    }

    /** The App GitHub made from the manifest; any installation is forgotten. */
    async saveApp(app: StoredApp) {
        const sealed = this.box.seal(app);
        await this.uow.run(
            async () => {
                await this.write(KEYS.app, sealed);
                await this.write(KEYS.installation, null);
            },
            { label: 'save GitHub App' },
        );
    }

    async saveInstallation(id: string) {
        await this.write(KEYS.installation, id);
    }

    /** The App connected here; the environment's is used again. */
    async forgetApp() {
        await this.uow.run(
            async () => {
                await this.write(KEYS.app, null);
                await this.write(KEYS.installation, null);
                await this.write(KEYS.flow, null);
            },
            { label: 'forget GitHub App' },
        );
    }

    /** Whether an App is saved here that can't be opened. */
    async appUnreadable() {
        try {
            await this.storedApp();
            return false;
        } catch (error) {
            if (error instanceof SealedAppError) {
                return true;
            }
            throw error;
        }
    }

    /** The saved App's credentials, for the install step. */
    async connectedApp(): Promise<GitHubAppCredentials & { owner: string }> {
        const saved = await this.storedApp();
        if (!saved) {
            throw new FlowStateError('No GitHub App is connected here.');
        }
        return { id: saved.id, privateKey: saved.privateKey, owner: saved.owner };
    }

    /**
     * Starts a connect step for one admin: a random state, valid for an
     * hour, kept only as its hash. A new step replaces any other.
     */
    async startFlow(userId: string, phase: FlowPhase, owner: string) {
        const state = randomBytes(24).toString('base64url');
        const flow: StoredFlow = {
            hash: hash(state),
            userId,
            phase,
            owner,
            expiresAt: this.now() + FLOW_MS,
        };
        await this.write(KEYS.flow, JSON.stringify(flow));
        return state;
    }

    /**
     * The step `state` belongs to, when it is this admin's, in `phase` and
     * not expired; `consume` ends it, so it can't be used twice. Throws
     * `FlowStateError` otherwise. Read and ended in one unit of work, so
     * two callbacks with the same state can't both pass.
     */
    checkFlow(state: string, userId: string, phase: FlowPhase, consume: boolean) {
        return this.uow.run(() => this.takeFlow(state, userId, phase, consume), {
            label: 'check GitHub step',
        });
    }

    private async takeFlow(state: string, userId: string, phase: FlowPhase, consume: boolean) {
        const raw = await this.read(KEYS.flow);
        const flow = raw ? (JSON.parse(raw) as StoredFlow) : undefined;
        const given = Buffer.from(hash(state), 'hex');
        const ok =
            !!flow &&
            flow.userId === userId &&
            flow.phase === phase &&
            flow.expiresAt > this.now() &&
            timingSafeEqual(given, Buffer.from(flow.hash, 'hex'));
        if (!ok) {
            throw new FlowStateError(
                'This GitHub step has expired, was used already, or was not started here; select Connect GitHub again.',
            );
        }
        if (consume) {
            await this.write(KEYS.flow, null);
        }
        return { owner: flow!.owner };
    }

    /** The saved App sealed again under the current data key (CB-62). */
    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        const sealed = await this.read(KEYS.app);
        if (!sealed) {
            return result;
        }
        let next: string | undefined;
        try {
            next = this.box.reseal(sealed);
        } catch {
            result.unreadable++;
            return result;
        }
        if (next && (await this.settings.replace(KEYS.app, sealed, next))) {
            result.resealed++;
        }
        return result;
    }

    /** The saved App's seal, for the data key's counts (CB-62). */
    async sealStates() {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const sealed = await this.read(KEYS.app);
        if (sealed) {
            counts[this.box.state(this.box.valueKey(sealed))]++;
        }
        return counts;
    }
}
