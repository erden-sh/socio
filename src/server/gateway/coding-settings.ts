import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { transaction } from '@socio/data/open';
import {
    CODING_LIMIT_KEYS,
    CODING_MODEL_ID,
    PERSONAL_MODEL_PREFIX,
    normalRepository,
    validCodingLimit,
    type CodingBackendOption,
    type CodingLimitKey,
    type CodingLimits,
    type CodingModelView,
} from '@socio/shared/coding/coding-gateway';
import type { InferenceBackendView } from '@socio/shared/inference';

import { isPublicAddress } from '../../net/public-address.js';
import type { ActorAuditShape } from '../actors/contract.js';
import type { CodingSettingsShape, ModelRecord, UsableModel } from '../coding/contract.js';
import type { InferenceShape } from '../inference/contract.js';

import { LimitRows, ModelRows } from './infra/sqlite/rows.js';
import { codingLimitsInForce } from './limits.js';

/**
 * Whether a backend's address sends code off the operator's servers, by
 * default (CB-239): a public IP address or a public-looking host
 * name. Private and loopback addresses, `localhost`, `.local`, `.internal`,
 * `.lan`, `.home.arpa` and single-label names (a service on the same
 * Docker network) are the operator's own. Read from the URL alone: no
 * lookup is made, and an admin can say otherwise per model.
 */
export function outsideByDefault(baseUrl: string): boolean {
    let host: string;
    try {
        host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
        return true;
    }
    if (isIP(host)) {
        return isPublicAddress(host);
    }
    if (host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) {
        return false;
    }
    return true;
}

const hostOf = (baseUrl: string | undefined) => {
    try {
        return baseUrl ? new URL(baseUrl).hostname : null;
    } catch {
        return null;
    }
};

/** An audit row's detail holds at most this much (actors/audit.ts). */
const DETAIL_MAX = 2000;

/**
 * A repository list's change as audit details: what was added and
 * removed, not both whole lists, split over as many rows as it takes so
 * the audit's 2000-character cut never loses a name. Each part names its
 * place (`part`, `of`).
 */
export function repositoryChanges(before: readonly string[], after: readonly string[]): string[] {
    const was = new Set(before);
    const now = new Set(after);
    const changes: ['added' | 'removed', string][] = [
        ...after.filter((repo) => !was.has(repo)).map((repo) => ['added', repo]),
        ...before.filter((repo) => !now.has(repo)).map((repo) => ['removed', repo]),
    ] as ['added' | 'removed', string][];
    const parts: { added: string[]; removed: string[] }[] = [{ added: [], removed: [] }];
    // Room for `"part":NNN,"of":NNN,"count":NNN` around each part.
    const room = DETAIL_MAX - 60;
    for (const [kind, repo] of changes) {
        let part = parts.at(-1)!;
        if (JSON.stringify(part).length + JSON.stringify(repo).length + 1 > room) {
            parts.push((part = { added: [], removed: [] }));
        }
        part[kind].push(repo);
    }
    return parts.map((part, index) =>
        JSON.stringify({
            ...part,
            count: after.length,
            ...(parts.length > 1 ? { part: index + 1, of: parts.length } : {}),
        }),
    );
}

/** A model's fields as an admin set them, for the audit's old and new. */
const settingOf = (model: ModelRecord) => ({
    label: model.label,
    backendId: model.backendId,
    upstreamModel: model.upstreamModel,
    maxOutputTokens: model.maxOutputTokens,
    contextWindow: model.contextWindow,
    acceptsImages: model.acceptsImages,
    outsideProvider: model.outsideProvider,
    enabled: model.enabled,
});

/** An admin's create or edit of a coding model. */
export const codingModelInput = z
    .object({
        label: z.string().trim().min(1).max(80),
        backendId: z.string().trim().min(1).max(100),
        upstreamModel: z.string().trim().min(1).max(200),
        maxOutputTokens: z.number().int().min(1).max(1_000_000),
        contextWindow: z.number().int().min(1_024).max(10_000_000).nullable().optional(),
        acceptsImages: z.boolean().optional(),
        outsideProvider: z.boolean().nullable().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

export class CodingSettingsError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 = 400,
    ) {
        super(message);
    }
}

/**
 * Settings → Coding's models and limits (CB-239), admin-edited
 * over the env defaults. Every change is a `setting` row in `actor_audit`,
 * written in the same transaction as the change, with the admin and the
 * old and new values. No model row holds a key: the
 * backend's stays with the inference registry.
 */
export class CodingSettings implements CodingSettingsShape {
    private models: ModelRows;
    private limitRows: LimitRows;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: {
            inference: InferenceShape;
            audit: ActorAuditShape;
            defaults: CodingLimits;
            now?: () => number;
        },
    ) {
        this.models = new ModelRows(db);
        this.limitRows = new LimitRows(db);
        this.now = options.now ?? Date.now;
    }

    get limitDefaults(): CodingLimits {
        return this.options.defaults;
    }
    /** The limits in force, read on every use (another runtime may save). */
    limits(): CodingLimits {
        return codingLimitsInForce(this.limitRows.all(), this.options.defaults);
    }

    model(id: string) {
        return this.models.get(id);
    }

    private async backends(): Promise<Map<string, InferenceBackendView>> {
        const state = await this.options.inference.operatorState();
        return new Map(
            state.backends
                .filter((backend) => backend.kind === 'openai-compatible')
                .map((backend) => [backend.id, backend]),
        );
    }

    /** Whether a model's code leaves the operator's servers, in force. */
    static outside(model: Pick<ModelRecord, 'outsideProvider'>, backend: { config: { baseUrl: string } } | undefined) {
        if (model.outsideProvider !== null) {
            return model.outsideProvider;
        }
        // A removed backend is unknown: treat it as outside.
        return backend ? outsideByDefault(backend.config.baseUrl) : true;
    }

    private view(model: ModelRecord, backend: InferenceBackendView | undefined): CodingModelView {
        return {
            id: model.id,
            label: model.label,
            backendId: model.backendId,
            backendLabel: backend?.label ?? null,
            backendReady: backend?.status === 'ready',
            backendHost: hostOf(backend?.config.baseUrl),
            upstreamModel: model.upstreamModel,
            maxOutputTokens: model.maxOutputTokens,
            contextWindow: model.contextWindow,
            acceptsImages: model.acceptsImages,
            outsideProviderSetting: model.outsideProvider,
            outsideProvider: CodingSettings.outside(model, backend),
            enabled: model.enabled,
            repositories: this.models.repositories(model.id),
            updatedAt: model.updatedAt,
        };
    }

    /** Every listed model, for Settings → Coding. */
    async views(): Promise<CodingModelView[]> {
        const backends = await this.backends();
        return this.models.all().map((model) => this.view(model, backends.get(model.backendId)));
    }

    /** The shared backends a model can be listed on. */
    async backendOptions(): Promise<CodingBackendOption[]> {
        return [...(await this.backends()).values()].map((backend) => ({
            id: backend.id,
            label: backend.label,
            model: backend.config.model,
            host: hostOf(backend.config.baseUrl),
            outsideByDefault: outsideByDefault(backend.config.baseUrl),
            ready: backend.status === 'ready',
        }));
    }

    /**
     * Whether a repository's sessions may use a model: listed and enabled,
     * and either not an outside provider or allowed for that repository by
     * an admin.
     */
    private permitted(model: ModelRecord, repository: string, backend: { config: { baseUrl: string } } | undefined) {
        if (!model.enabled) {
            return false;
        }
        if (!CodingSettings.outside(model, backend)) {
            return true;
        }
        const normal = normalRepository(repository);
        return !!normal && this.models.allowedFor(model.id, normal);
    }

    /**
     * The models a session on `repository` may be offered (the session
     * card): the ones whose backend is ready and that the repository may use.
     */
    async forRepository(repository: string): Promise<CodingModelView[]> {
        const backends = await this.backends();
        return this.models
            .all()
            .filter((model) => {
                const backend = backends.get(model.backendId);
                return backend?.status === 'ready' && this.permitted(model, repository, backend);
            })
            .map((model) => this.view(model, backends.get(model.backendId)));
    }

    /**
     * A model a session on `repository` may use now, with its endpoint; or
     * undefined (unlisted, disabled, its backend not ready, or an outside
     * provider the repository isn't allowed). Read per request.
     */
    async usable(modelId: string, repository: string): Promise<UsableModel | undefined> {
        const model = this.models.get(modelId);
        if (!model?.enabled) {
            return undefined;
        }
        const endpoint = await this.options.inference.codingEndpoint(model.backendId, model.upstreamModel);
        if (!endpoint) {
            return undefined;
        }
        const backend = { config: { baseUrl: endpoint.baseUrl } };
        if (!this.permitted(model, repository, backend)) {
            return undefined;
        }
        return {
            model,
            outsideProvider: CodingSettings.outside(model, backend),
            endpoint,
        };
    }

    private record(by: string, action: string, resourceId: string, before: unknown, after: unknown) {
        this.recordDetail(by, action, resourceId, [JSON.stringify({ old: before ?? null, new: after ?? null })]);
    }

    private recordDetail(by: string, action: string, resourceId: string, details: string[]) {
        const correlationId = `setting-${this.now()}`;
        for (const detail of details) {
            this.options.audit.recordIn({
                correlationId,
                phase: 'setting',
                actorBy: by,
                action,
                resourceKind: 'coding',
                resourceId,
                detail,
            });
        }
    }

    /** Lists or edits a model; the backend must exist. */
    async saveModel(id: string, input: unknown, by: string) {
        if (!CODING_MODEL_ID.test(id)) {
            throw new CodingSettingsError(
                'A model name is lowercase letters, digits, periods, dashes and underscores.',
            );
        }
        // Sessions on a person's own plan use these names.
        if (id.startsWith(PERSONAL_MODEL_PREFIX)) {
            throw new CodingSettingsError(
                `Model names starting with “${PERSONAL_MODEL_PREFIX}” are for people’s own plans.`,
            );
        }
        const parsed = codingModelInput.safeParse(input);
        if (!parsed.success) {
            throw new CodingSettingsError('Check the model’s fields.');
        }
        const fields = parsed.data;
        const backends = await this.backends();
        if (!backends.has(fields.backendId)) {
            throw new CodingSettingsError('That backend doesn’t exist.', 404);
        }
        const now = this.now();
        await transaction(this.db, 'save coding model', () => {
            const before = this.models.get(id);
            const next: ModelRecord = {
                id,
                label: fields.label,
                backendId: fields.backendId,
                upstreamModel: fields.upstreamModel,
                maxOutputTokens: fields.maxOutputTokens,
                contextWindow: fields.contextWindow ?? null,
                acceptsImages: fields.acceptsImages ?? false,
                // An admin's mark is about one backend's address: moving the
                // model to another backend without saying again follows the new
                // address.
                outsideProvider:
                    fields.outsideProvider !== undefined
                        ? fields.outsideProvider
                        : before && before.backendId !== fields.backendId
                          ? null
                          : (before?.outsideProvider ?? null),
                enabled: fields.enabled ?? before?.enabled ?? true,
                createdAt: before?.createdAt ?? now,
                updatedAt: now,
                updatedBy: by,
            };
            this.models.upsert(next);
            this.record(by, 'coding.model.save', id, before && settingOf(before), settingOf(next));
        });
        return this.view(this.models.get(id)!, backends.get(fields.backendId));
    }

    /** Removes a model and its repository allowances; false if unknown. */
    deleteModel(id: string, by: string) {
        return transaction(this.db, 'remove coding model', () => {
            const before = this.models.get(id);
            if (!before) {
                return false;
            }
            const repositories = this.models.repositories(id);
            this.models.delete(id);
            this.record(by, 'coding.model.remove', id, { ...settingOf(before), repositories }, null);
            return true;
        });
    }

    /**
     * The repositories an outside-provider model is allowed for, replacing
     * the list; each change audited.
     */
    async setRepositories(id: string, input: unknown, by: string) {
        if (!Array.isArray(input) || input.length > 500 || !input.every((item) => typeof item === 'string')) {
            throw new CodingSettingsError('Give a list of owner/name repositories.');
        }
        const repositories = new Set<string>();
        for (const item of input as string[]) {
            const normal = normalRepository(item);
            if (!normal) {
                throw new CodingSettingsError(`“${item.slice(0, 120)}” is not an owner/name repository.`);
            }
            repositories.add(normal);
        }
        const sorted = [...repositories].sort();
        const ok = await transaction(this.db, 'allow coding model', () => {
            if (!this.models.get(id)) {
                return false;
            }
            const before = this.models.repositories(id);
            this.models.setRepositories(id, sorted, by, this.now());
            this.recordDetail(by, 'coding.model.repositories', id, repositoryChanges(before, sorted));
            return true;
        });
        if (!ok) {
            throw new CodingSettingsError('That model isn’t listed.', 404);
        }
        return sorted;
    }

    /** An admin's limits: a number sets one, null returns it to its default. */
    async saveLimits(input: unknown, by: string) {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            throw new CodingSettingsError('Give the limits to change.');
        }
        const changes: [CodingLimitKey, number | null][] = [];
        for (const [key, value] of Object.entries(input)) {
            if (!(CODING_LIMIT_KEYS as readonly string[]).includes(key)) {
                throw new CodingSettingsError(`Unknown limit: ${key.slice(0, 60)}.`);
            }
            if (value !== null && !validCodingLimit(key as CodingLimitKey, value)) {
                throw new CodingSettingsError(`${key} is out of range.`);
            }
            changes.push([key as CodingLimitKey, value as number | null]);
        }
        await transaction(this.db, 'save coding limits', () => {
            const before = this.limits();
            const at = this.now();
            for (const [key, value] of changes) {
                this.limitRows.set(key, value, by, at);
            }
            const after = this.limits();
            const changed = Object.fromEntries(
                CODING_LIMIT_KEYS.filter((key) => before[key] !== after[key]).map((key) => [
                    key,
                    [before[key], after[key]],
                ]),
            );
            if (Object.keys(changed).length) {
                this.record(
                    by,
                    'coding.limits',
                    'limits',
                    Object.fromEntries(Object.entries(changed).map(([key, [old]]) => [key, old])),
                    Object.fromEntries(Object.entries(changed).map(([key, [, value]]) => [key, value])),
                );
            }
        });
        return this.limits();
    }
}
