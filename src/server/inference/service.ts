import type { DatabaseSync } from 'node:sqlite';

import type { z } from 'zod';

import { sqliteData, type SqliteData } from '@socio/data/open';
import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import type {
    BackendStatus,
    InferenceAvailability,
    InferenceBackendView,
    ModelChoice,
    ModelOption,
    ModelOptions,
    OperatorInferenceState,
    UserInferenceKind,
    UserInferenceState,
} from '@socio/shared/inference';
import { modelChoiceKey } from '@socio/shared/inference';
import { compareText } from '@socio/shared/locale';

import type {
    ChatCompletionsEndpoint,
    InferenceShape,
    ByoCodingTransport,
    ByoConnection,
    ByoConnectionAccess,
    ByoKind,
    InferenceModel,
    InferenceRequest,
    InferenceResolution,
    BackendRecord,
    ModelSettings,
} from './contract.js';
import { sqliteInferenceRepositories } from './infra/sqlite/index.js';
import {
    backendFromSettings,
    backendInput,
    fieldsOf,
    openAICompatibleModel,
    probeBackend,
} from './openai-compatible.js';
import { InferenceStore } from './store.js';
import { InferenceTimings } from './timings.js';
import { ByoError, PERSONAL_PURPOSES } from './types.js';

const KIND_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** The environment's model settings as seeded, compared on later boots. */
const SEEDED_FIELDS = [
    ['baseUrl', 'OPENAI_BASE_URL'],
    ['model', 'OPENAI_MODEL'],
    ['apiKey', 'OPENAI_API_KEY'],
    ['maxCompletionTokens', 'MODEL_MAX_COMPLETION_TOKENS'],
    ['acceptsImages', 'MODEL_ACCEPTS_IMAGES'],
    ['maxImages', 'MODEL_MAX_IMAGES'],
    ['contextWindow', 'MODEL_CONTEXT_WINDOW'],
    ['titleModelOptions', 'TITLE_MODEL_OPTIONS'],
] as const;
const snapshot = (settings: ModelSettings) =>
    Object.fromEntries(SEEDED_FIELDS.map(([field]) => [field, settings[field] ?? null]));

export interface InferenceServiceOptions {
    /**
     * The keys for secrets at rest (CB-62): DATA_ENCRYPTION_KEY and the
     * previous one, and SESSION_SECRET for the legacy key; a string is
     * SESSION_SECRET alone.
     */
    secret: string | DataKeyring;
    /** For the operator's Test (tests replace it). */
    fetch?: typeof fetch;
    /** Operational lines only: never keys, tokens or conversation content. */
    log?: (line: string) => void;
    /** The clock (tests replace it); Date.now when left out. */
    now?: () => number;
}

/**
 * The inference registry: the operator's shared backends, the
 * bring-your-own kinds code registers, users' connections, and per-turn
 * resolution. Selection is manual: the operator's default backend, no
 * failover, and no live probing per turn (a backend is used when it is
 * enabled and complete; "Test" is the operator's own check).
 */
export class InferenceService implements InferenceShape {
    readonly store: InferenceStore;
    /** Response times per model, for the chat's wait estimates. */
    readonly timings: InferenceTimings;
    private uow: SqliteData['uow'];
    private kinds = new Map<string, ByoKind>();
    private fetchImpl: typeof fetch;
    private log: (line: string) => void;
    private clock: () => number;
    /** The environment's settings, until the first read seeds from them. */
    private seedFrom?: ModelSettings;
    /** The environment's seed while it is being stored (`seed`). */
    private seeding?: Promise<unknown>;
    constructor(db: DatabaseSync, options: InferenceServiceOptions) {
        const data = sqliteData(db);
        const repos = sqliteInferenceRepositories(data);
        this.uow = data.uow;
        this.store = new InferenceStore(data.uow, repos, new SecretBox(options.secret));
        this.timings = new InferenceTimings(repos.timings);
        this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
        this.log = options.log ?? ((line) => console.log(line));
        this.clock = options.now ?? (() => Date.now());
    }

    /** Registers a bring-your-own kind; the operator then decides whether users may connect it. */
    register(kind: ByoKind) {
        if (!KIND_ID.test(kind.id)) {
            throw new Error(`Invalid inference kind id "${kind.id}".`);
        }
        if (this.kinds.has(kind.id)) {
            throw new Error(`Inference kind "${kind.id}" is registered twice.`);
        }
        this.kinds.set(kind.id, kind);
    }
    byoKinds(): ByoKind[] {
        return [...this.kinds.values()];
    }
    /** Registered kinds the operator allows, in the operator's order. */
    async allowedKinds(): Promise<ByoKind[]> {
        await this.seeded();
        return (await this.store.allowedByoKinds())
            .map((id) => this.kinds.get(id))
            .filter((kind): kind is ByoKind => !!kind);
    }

    /**
     * Seeds the first backend from the environment's model settings, once:
     * when no backend exists yet and OPENAI_BASE_URL and OPENAI_MODEL are set,
     * it is created and made the default. From then on the database is the
     * source of truth; a later boot whose settings differ only logs a notice.
     * Reads wait for it, so nothing sees the registry before the seed.
     */
    seed(settings: ModelSettings): Promise<'seeded' | 'kept' | 'none'> {
        const seeding = this.seedOnce(settings);
        const settled = (this.seeding = seeding.catch(() => undefined));
        void settled.then(() => {
            if (this.seeding === settled) {
                this.seeding = undefined;
            }
        });
        return seeding;
    }
    /**
     * `seed`, on the registry's first read rather than at once: the platform
     * is built before anything uses it, and the seed's unit of work then
     * opens on a caller's path like any other (CB-110).
     */
    seedOnFirstUse(settings: ModelSettings) {
        this.seedFrom = settings;
    }
    /** Waits for the environment's seed, while one is due or being stored. */
    private async seeded() {
        const settings = this.seedFrom;
        if (settings) {
            this.seedFrom = undefined;
            void this.seed(settings).catch((error: unknown) => reportFailure('Inference seed', [safeFailure(error)]));
        }
        // Inside a unit of work the seed may be queued behind it: go on.
        if (this.seeding && !this.uow.active) {
            await this.seeding;
        }
    }
    private async seedOnce(settings: ModelSettings): Promise<'seeded' | 'kept' | 'none'> {
        // Most boots only read; one that writes reads again in its unit, so
        // two boots can't both seed.
        const stored = await this.store.envSeed();
        if (stored === undefined && (!settings.baseUrl || !settings.model) && !(await this.store.hasBackends())) {
            return 'none';
        }
        const step =
            stored !== undefined
                ? { seeded: stored }
                : await this.uow.run<
                      | { seeded: Record<string, unknown> }
                      | { result: 'kept' | 'none' }
                      | { result: 'seeded'; label: string }
                  >(
                      async () => {
                          const seeded = await this.store.envSeed();
                          if (seeded !== undefined) {
                              return { seeded };
                          }
                          if (await this.store.hasBackends()) {
                              await this.store.setEnvSeed({});
                              return { result: 'kept' };
                          }
                          if (!settings.baseUrl || !settings.model) {
                              return { result: 'none' };
                          }
                          const backend = await this.store.createBackend(backendFromSettings(settings));
                          await this.store.setDefaultBackendId(backend.id);
                          await this.store.setEnvSeed(snapshot(settings));
                          return { result: 'seeded', label: backend.label };
                      },
                      { label: 'seed inference backend' },
                  );
        if ('result' in step) {
            if (step.result === 'seeded') {
                this.log(
                    `Inference: created the backend "${step.label}" from OPENAI_BASE_URL and OPENAI_MODEL and made it the default. From now on backends are managed on the Operator page; the environment's model settings no longer apply.`,
                );
            }
            return step.result;
        }
        const { seeded } = step;
        if (!Object.keys(seeded).length) {
            if (settings.baseUrl) {
                this.log(
                    'Inference: OPENAI_BASE_URL and the other model settings are ignored; backends are managed on the Operator page.',
                );
            }
            return 'kept';
        }
        const current = snapshot(settings);
        const changed = SEEDED_FIELDS.filter(
            ([field]) => JSON.stringify(seeded[field] ?? null) !== JSON.stringify(current[field]),
        ).map(([, name]) => name);
        if (changed.length) {
            this.log(
                `Inference: ${changed.join(', ')} changed since the first backend was seeded; the database wins, so the change does not apply. Edit backends on the Operator page instead.`,
            );
        }
        return 'kept';
    }

    backendStatus(backend: BackendRecord): BackendStatus {
        if (!backend.enabled) {
            return 'disabled';
        }
        if (backend.keyUnreadable) {
            return 'key_unreadable';
        }
        if (!backend.config.baseUrl || !backend.config.model) {
            return 'incomplete';
        }
        return 'ready';
    }
    private modelOf(backend: BackendRecord): InferenceModel {
        return openAICompatibleModel({
            source: { type: 'shared', backendId: backend.id },
            label: backend.label,
            baseUrl: backend.config.baseUrl,
            model: backend.config.model,
            apiKey: backend.apiKey,
            capabilities: backend.capabilities,
            titleModelOptions: backend.config.titleModelOptions,
        });
    }
    /** The default shared backend, when it is enabled and complete. */
    async sharedBackend(): Promise<BackendRecord | undefined> {
        await this.seeded();
        const id = await this.store.defaultBackendId();
        const backend = id ? await this.store.backend(id) : undefined;
        return backend && this.backendStatus(backend) === 'ready' ? backend : undefined;
    }
    /** The default shared backend's model (titles, learning). */
    async shared(): Promise<InferenceModel | undefined> {
        const backend = await this.sharedBackend();
        return backend && this.modelOf(backend);
    }
    /**
     * One listed shared backend's Chat Completions endpoint for a coding
     * session's `model` (CB-239): `resolve` gives
     * only the default backend to non-personal purposes, while the model
     * gateway maps several backends and models. Only a ready backend, and
     * never a personal connection (purpose `coding`). Holds the backend's
     * key: it stays in this process, in the upstream request's header only.
     */
    async codingEndpoint(backendId: string, model: string): Promise<ChatCompletionsEndpoint | undefined> {
        await this.seeded();
        const backend = await this.store.backend(backendId);
        if (!backend || this.backendStatus(backend) !== 'ready') {
            return undefined;
        }
        return {
            baseUrl: backend.config.baseUrl,
            ...(backend.apiKey ? { apiKey: backend.apiKey } : {}),
            model,
            maxCompletionTokens: backend.capabilities.maxCompletionTokens,
        };
    }
    /**
     * A named kind's plan for a person's coding session (per-user providers):
     * the plan for the kind the user chose, if they are connected to it and it
     * can serve coding (`codingTransport`). Undefined otherwise. Only ever
     * asked for the session's own person.
     */
    async personalCodingPlanFor(
        userId: string,
        kindId: string,
    ): Promise<{ kind: string; label: string; model: string } | undefined> {
        const found = (await this.connected(userId)).find((entry) => entry.kind.id === kindId);
        if (!found?.kind.codingTransport) {
            return undefined;
        }
        return { kind: found.kind.id, label: found.kind.label, model: (await this.byoModel(found.kind)) ?? '' };
    }
    /**
     * The transport to that plan for one request (may refresh the person's
     * sign-in), or undefined when the kind isn't allowed, connected or able
     * to serve. Holds the person's credential: it stays in this process.
     */
    async personalCodingTransport(userId: string, kindId: string): Promise<ByoCodingTransport | undefined> {
        const found = (await this.connected(userId)).find((entry) => entry.kind.id === kindId);
        if (!found?.kind.codingTransport) {
            return undefined;
        }
        try {
            const transport = await found.kind.codingTransport(found.connection, this.access(userId, found.kind), {
                model: await this.byoModel(found.kind),
            });
            if (!transport) {
                return undefined;
            }
            // Wrap the transport's send with the cross-runtime refresh lease
            // (per-user providers step 5): the kind's transport refreshes a
            // single-use token inside send; the lease stops two gateway
            // runtimes both spending it. A runtime that can't acquire the
            // lease waits for the holder to finish (the credentials rotate in
            // the store) then proceeds — its now-stale token is re-read by
            // the kind's transport on the next call. Conservative: leases
            // only gate coding transports (the path that holds a plan token).
            return this.withRefreshLease(transport, userId, kindId);
        } catch (error) {
            reportFailure(`Inference connection (${kindId})`, [safeFailure(error)]);
            return undefined;
        }
    }

    /**
     * Wraps a byo coding transport's send with the cross-runtime refresh
     * lease. Acquires a short lease before each send; if another runtime
     * holds it, waits (polling) until it expires or the credentials rotate,
     * then proceeds. Releases the lease when send settles. A short runtime
     * id distinguishes the two gateway runtimes.
     */
    private withRefreshLease(transport: ByoCodingTransport, userId: string, kindId: string): ByoCodingTransport {
        const runtimeId = process.pid.toString(36);
        const leaseMs = 10_000;
        const pollMs = 500;
        const maxWaitMs = 15_000;
        const send = async (body: string, signal?: AbortSignal) => {
            const now = this.clock();
            const until = now + leaseMs;
            const lease = await this.store.tryLeaseRefresh(userId, kindId, runtimeId, until, now);
            if (!lease.acquired) {
                // Another runtime is refreshing: wait for it to finish (the
                // credentials rotate in the store) or the lease to expire.
                const deadline = Math.min(lease.leasedUntil + leaseMs, now + maxWaitMs);
                let waited = 0;
                while (this.clock() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                    waited += pollMs;
                    const again = await this.store.tryLeaseRefresh(
                        userId,
                        kindId,
                        runtimeId,
                        this.clock() + leaseMs,
                        this.clock(),
                    );
                    if (again.acquired) {
                        break;
                    }
                }
            }
            try {
                return await transport.send(body, signal);
            } finally {
                await this.store.releaseLease(userId, kindId, runtimeId).catch(() => {});
            }
        };
        return { ...transport, send };
    }
    /** Whether anything is registered: a backend, or an allowed kind. */
    async registered() {
        await this.seeded();
        return (await this.store.hasBackends()) || (await this.allowedKinds()).length > 0;
    }

    private access(userId: string, kind: ByoKind): ByoConnectionAccess {
        return {
            userId,
            connection: () => this.store.connection(userId, kind.id),
            save: (credentials, meta, options) =>
                this.store.saveConnection(userId, kind.id, credentials, meta, options),
            remove: () => this.store.deleteConnection(userId, kind.id),
        };
    }
    /** The operator's model for a kind, else its default; undefined without `models`. */
    async byoModel(kind: ByoKind): Promise<string | undefined> {
        return kind.models ? this.chosenModel(kind, await this.store.byoModels()) : undefined;
    }
    private chosenModel(kind: ByoKind, models: Record<string, string>) {
        if (!kind.models) {
            return undefined;
        }
        const chosen = models[kind.id];
        return kind.models.choices.some((choice) => choice.id === chosen) ? chosen : kind.models.default;
    }
    /** The user's connected, allowed kinds with their connections. */
    private async connected(userId: string) {
        const found: { kind: ByoKind; connection: ByoConnection }[] = [];
        for (const kind of await this.allowedKinds()) {
            const connection = await this.store.connection(userId, kind.id);
            if (!connection) {
                continue;
            }
            try {
                if (kind.status(connection).state === 'connected') {
                    found.push({ kind, connection });
                }
            } catch (error) {
                reportFailure(`Inference status (${kind.id})`, [safeFailure(error)]);
            }
        }
        return found;
    }

    /**
     * The model picker's entries for a user: every ready backend (the
     * default first), and each allowed kind's models (available when the
     * user is connected to it). Offline, like `availability`.
     */
    async options(userId: string): Promise<ModelOptions> {
        await this.seeded();
        const options: ModelOption[] = [];
        // The default backend first, then the others by name.
        const defaultId = await this.store.defaultBackendId();
        const backends = (await this.store.backends()).sort(
            (x, y) => +(y.id === defaultId) - +(x.id === defaultId) || compareText(x.label, y.label),
        );
        for (const backend of backends) {
            if (this.backendStatus(backend) !== 'ready') {
                continue;
            }
            const choice: ModelChoice = { source: 'shared', backendId: backend.id };
            options.push({
                key: modelChoiceKey(choice),
                choice,
                label: backend.config.model,
                group: backend.label,
                available: true,
            });
        }
        const connected = new Set((await this.connected(userId)).map(({ kind }) => kind.id));
        for (const kind of await this.allowedKinds()) {
            const available = connected.has(kind.id);
            const detail = available ? undefined : `Connect ${kind.label} in Account → Inference to use it.`;
            const models = kind.models?.choices ?? [];
            if (!models.length) {
                const choice: ModelChoice = { source: 'byo', kind: kind.id };
                options.push({
                    key: modelChoiceKey(choice),
                    choice,
                    label: kind.label,
                    group: kind.label,
                    available,
                    ...(detail ? { detail } : {}),
                });
            }
            for (const model of models) {
                const choice: ModelChoice = {
                    source: 'byo',
                    kind: kind.id,
                    model: model.id,
                };
                options.push({
                    key: modelChoiceKey(choice),
                    choice,
                    label: model.label,
                    group: kind.label,
                    ...(model.description ? { description: model.description } : {}),
                    available,
                    ...(detail ? { detail } : {}),
                });
            }
        }
        return {
            options,
            automatic: (await this.availability(userId)).label ?? null,
        };
    }

    /**
     * Why a choice can't be saved: an unknown or unready backend, a kind the
     * operator doesn't allow, or a model the kind doesn't offer. With
     * `userId`, also when that user can't run on it now (not connected).
     */
    async choiceProblem(choice: ModelChoice, userId?: string): Promise<string | undefined> {
        await this.seeded();
        if (choice.source === 'shared') {
            const backend = await this.store.backend(choice.backendId);
            if (!backend || this.backendStatus(backend) !== 'ready') {
                return 'That backend is not available. Pick another model.';
            }
            return undefined;
        }
        const kind = (await this.allowedKinds()).find((entry) => entry.id === choice.kind);
        if (!kind) {
            return 'That kind of connection is not allowed.';
        }
        if (choice.model !== undefined && !kind.models?.choices.some((entry) => entry.id === choice.model)) {
            return `${kind.label} has no model "${choice.model.slice(0, 80)}".`;
        }
        if (userId && !(await this.connected(userId)).some((entry) => entry.kind.id === kind.id)) {
            return `Connect ${kind.label} in Account → Inference first.`;
        }
        return undefined;
    }

    /** The model of a choice for this user, or undefined when it can't serve. */
    private async chosen(
        choice: ModelChoice,
        userId: string | undefined,
        personal: boolean,
    ): Promise<InferenceModel | undefined> {
        if (choice.source === 'shared') {
            const backend = await this.store.backend(choice.backendId);
            return backend && this.backendStatus(backend) === 'ready' ? this.modelOf(backend) : undefined;
        }
        // A user's own connection serves only their own turns.
        if (!personal || !userId) {
            return undefined;
        }
        const found = (await this.connected(userId)).find((entry) => entry.kind.id === choice.kind);
        if (!found) {
            return undefined;
        }
        const { kind, connection } = found;
        const model =
            choice.model && kind.models?.choices.some((entry) => entry.id === choice.model)
                ? choice.model
                : await this.byoModel(kind);
        try {
            return await kind.adapterFor(connection, this.access(userId, kind), {
                model,
            });
        } catch (error) {
            reportFailure(`Inference connection (${kind.id})`, [safeFailure(error)]);
            return undefined;
        }
    }

    /**
     * The model for a turn or request. A `choice` (the conversation's model,
     * else its Dot's default) comes first, for the user's own turns; when it
     * can't serve, a `strict` one fails the turn and a Dot's default gives way
     * to the automatic order: the user's first connected, allowed kind, then
     * the default shared backend (also what all other work runs on); else
     * nothing, with the reason the chat explains.
     */
    async resolve({ userId, purpose, choice, strict }: InferenceRequest): Promise<InferenceResolution> {
        await this.seeded();
        const personal = PERSONAL_PURPOSES.has(purpose) && !!userId;
        if (choice && personal) {
            const model = await this.chosen(choice, userId, personal);
            if (model) {
                return { ok: true, model };
            }
            if (strict) {
                return { ok: false, reason: 'choice_unavailable' };
            }
        }
        if (personal) {
            for (const { kind, connection } of await this.connected(userId)) {
                try {
                    const model = await kind.adapterFor(connection, this.access(userId, kind), {
                        model: await this.byoModel(kind),
                    });
                    if (model) {
                        return { ok: true, model };
                    }
                } catch (error) {
                    reportFailure(`Inference connection (${kind.id})`, [safeFailure(error)]);
                }
            }
        }
        const shared = await this.shared();
        if (shared) {
            return { ok: true, model: shared };
        }
        return {
            ok: false,
            reason: personal && (await this.allowedKinds()).length ? 'connect_byo' : 'ask_operator',
        };
    }

    /** Whether a user's chats have a model now (setup, the chat's state); offline. */
    async availability(userId?: string): Promise<InferenceAvailability> {
        await this.seeded();
        const byoAllowed = (await this.allowedKinds()).length > 0;
        const own = userId ? (await this.connected(userId))[0] : undefined;
        if (own) {
            return {
                available: true,
                source: 'byo',
                label: own.kind.label,
                byoAllowed,
            };
        }
        const shared = await this.sharedBackend();
        if (shared) {
            return {
                available: true,
                source: 'shared',
                label: shared.label,
                byoAllowed,
            };
        }
        return { available: false, byoAllowed };
    }

    private view(backend: BackendRecord, defaultId: string | null): InferenceBackendView {
        return {
            id: backend.id,
            kind: backend.kind,
            label: backend.label,
            enabled: backend.enabled,
            config: backend.config,
            hasApiKey: backend.hasApiKey,
            capabilities: backend.capabilities,
            status: this.backendStatus(backend),
            isDefault: defaultId === backend.id,
            lastTest: backend.lastTest,
            createdAt: backend.createdAt,
            updatedAt: backend.updatedAt,
        };
    }
    async operatorState(): Promise<OperatorInferenceState> {
        await this.seeded();
        const allowed = new Set(await this.store.allowedByoKinds());
        const defaultId = await this.store.defaultBackendId();
        const byoModels = await this.store.byoModels();
        return {
            backends: (await this.store.backends()).map((backend) => this.view(backend, defaultId)),
            defaultBackendId: defaultId,
            byoKinds: this.byoKinds().map((kind) => ({
                id: kind.id,
                label: kind.label,
                description: kind.description,
                allowed: allowed.has(kind.id),
                ...(kind.models
                    ? {
                          models: {
                              choices: kind.models.choices.map(({ id, label, description }) => ({
                                  id,
                                  label,
                                  ...(description ? { description } : {}),
                              })),
                              default: kind.models.default,
                              selected: this.chosenModel(kind, byoModels)!,
                              ...(kind.models.help ? { help: kind.models.help } : {}),
                          },
                      }
                    : {}),
            })),
        };
    }
    /** Creates a backend; the first one (while none is the default) becomes the default. */
    async createBackend(input: z.infer<typeof backendInput>) {
        await this.seeded();
        return this.uow.run(
            async () => {
                const backend = await this.store.createBackend(fieldsOf(input, true));
                // Created on the Operator page: the environment no longer seeds.
                if ((await this.store.envSeed()) === undefined) {
                    await this.store.setEnvSeed({});
                }
                let defaultId = await this.store.defaultBackendId();
                if (!defaultId) {
                    await this.store.setDefaultBackendId((defaultId = backend.id));
                }
                return this.view(backend, defaultId);
            },
            { label: 'add inference backend' },
        );
    }
    async updateBackend(id: string, input: z.infer<typeof backendInput>) {
        await this.seeded();
        return this.uow.run(
            async () => {
                const current = await this.store.backend(id);
                if (!current) {
                    return undefined;
                }
                const backend = await this.store.updateBackend(id, fieldsOf(input, current.enabled));
                return backend && this.view(backend, await this.store.defaultBackendId());
            },
            { label: 'change inference backend' },
        );
    }
    /** Removes a backend; returns what it was (for the audit), or undefined. */
    async deleteBackend(id: string) {
        await this.seeded();
        return this.uow.run(
            async () => {
                const backend = await this.store.backend(id);
                if (!backend || !(await this.store.deleteBackend(id))) {
                    return undefined;
                }
                if ((await this.store.defaultBackendId()) === id) {
                    await this.store.setDefaultBackendId(null);
                }
                return { label: backend.label, kind: backend.kind };
            },
            { label: 'remove inference backend' },
        );
    }
    /** Sets the default backend (manual selection), the allowed kinds and their models. */
    async updateSettings(settings: {
        defaultBackendId?: string | null;
        allowedByoKinds?: string[];
        byoModels?: Record<string, string | null>;
    }) {
        await this.seeded();
        await this.uow.run(() => this.saveSettings(settings), {
            label: 'save inference settings',
        });
        return this.operatorState();
    }
    private async saveSettings(settings: {
        defaultBackendId?: string | null;
        allowedByoKinds?: string[];
        byoModels?: Record<string, string | null>;
    }) {
        if (settings.defaultBackendId !== undefined) {
            if (settings.defaultBackendId !== null && !(await this.store.backend(settings.defaultBackendId))) {
                throw new ByoError('Backend not found.', 404);
            }
            await this.store.setDefaultBackendId(settings.defaultBackendId);
        }
        if (settings.allowedByoKinds) {
            const unknown = settings.allowedByoKinds.filter((id) => !this.kinds.has(id));
            if (unknown.length) {
                throw new ByoError(`Unknown inference kind: ${unknown.join(', ')}.`);
            }
            await this.store.setAllowedByoKinds(settings.allowedByoKinds);
        }
        for (const [id, model] of Object.entries(settings.byoModels ?? {})) {
            const kind = this.kinds.get(id);
            if (!kind?.models) {
                throw new ByoError(`Unknown inference kind: ${id}.`);
            }
            if (model !== null && !kind.models.choices.some((c) => c.id === model)) {
                throw new ByoError(`Unknown model for ${kind.label}: ${model}.`);
            }
            await this.store.setByoModel(id, model);
        }
    }
    /** The operator's Test: a local call to the backend's `/models`, recorded. */
    async testBackend(id: string) {
        await this.seeded();
        const backend = await this.store.backend(id);
        if (!backend) {
            return undefined;
        }
        const result = backend.keyUnreadable
            ? {
                  ok: false,
                  detail: 'The stored key can’t be read (the data key or SESSION_SECRET changed); enter it again.',
              }
            : await probeBackend(
                  {
                      baseUrl: backend.config.baseUrl,
                      model: backend.config.model,
                      apiKey: backend.apiKey,
                  },
                  this.fetchImpl,
              );
        await this.store.recordTest(id, { ...result, at: Date.now() });
        const tested = await this.store.backend(id);
        // Removed while it was being tested.
        if (!tested) {
            return undefined;
        }
        return this.view(tested, await this.store.defaultBackendId());
    }

    private async kindView(userId: string, kind: ByoKind, allowed: boolean) {
        const connection = await this.store.connection(userId, kind.id);
        let status: ReturnType<ByoKind['status']> = { state: 'disconnected' };
        if (connection) {
            try {
                status = kind.status(connection);
            } catch (error) {
                reportFailure(`Inference status (${kind.id})`, [safeFailure(error)]);
                status = { state: 'error', detail: 'This connection has a problem.' };
            }
        }
        const view: UserInferenceKind = {
            id: kind.id,
            label: kind.label,
            description: kind.description,
            state: status.state,
            ...(status.detail ? { detail: status.detail } : {}),
            ...(connection ? { connectedAt: connection.createdAt } : {}),
        };
        if (!allowed) {
            view.detail = 'An operator no longer allows this kind; disconnect it.';
        }
        return view;
    }
    /** The account dialog's Inference section: allowed kinds, plus disallowed ones still connected. */
    async userState(userId: string): Promise<UserInferenceState> {
        await this.seeded();
        const allowed = await this.allowedKinds();
        const allowedIds = new Set(allowed.map((kind) => kind.id));
        const leftover = (await this.store.connectedKinds(userId))
            .filter((id) => !allowedIds.has(id))
            .map((id) => this.kinds.get(id))
            .filter((kind): kind is ByoKind => !!kind);
        const availability = await this.availability(userId);
        const kinds: UserInferenceKind[] = [];
        for (const kind of allowed) {
            kinds.push(await this.kindView(userId, kind, true));
        }
        for (const kind of leftover) {
            kinds.push(await this.kindView(userId, kind, false));
        }
        return {
            kinds,
            active:
                availability.available && availability.source && availability.label
                    ? { source: availability.source, label: availability.label }
                    : null,
        };
    }
    async userKind(userId: string, kindId: string) {
        return (await this.userState(userId)).kinds.find((kind) => kind.id === kindId);
    }
    /** A kind's connect step for a user; only for allowed kinds. */
    async connect(userId: string, kindId: string, body: unknown) {
        const kind = (await this.allowedKinds()).find((entry) => entry.id === kindId);
        if (!kind) {
            throw new ByoError('This kind of connection is not allowed.', 404);
        }
        return kind.connect(this.access(userId, kind), body);
    }
    /** Deletes a user's connection (after the kind's own disconnect hook). */
    async disconnect(userId: string, kindId: string) {
        const kind = this.kinds.get(kindId);
        const connection = await this.store.connection(userId, kindId);
        if (kind?.disconnect && connection) {
            await kind
                .disconnect(connection)
                .catch((error) => reportFailure(`Inference disconnect (${kindId})`, [safeFailure(error)]));
        }
        return this.uow.run(
            async () => {
                const existed = (await this.store.connectedKinds(userId)).includes(kindId);
                await this.store.deleteConnection(userId, kindId);
                return existed;
            },
            { label: 'remove inference connection' },
        );
    }
    /** How many connections `forgetUser` would delete (a deactivation preview). */
    async connectionCountOf(userId: string) {
        return (await this.store.connectedKinds(userId)).length;
    }
    /** Deletes every connection of a removed user. */
    async forgetUser(userId: string) {
        for (const kind of await this.store.connectedKinds(userId)) {
            await this.disconnect(userId, kind);
        }
    }
}
