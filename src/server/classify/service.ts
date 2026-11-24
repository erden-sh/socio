import type { DatabaseSync } from 'node:sqlite';

import type { EndpointSource } from '@socio/foundation/inference/endpoints';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { operationsSettingsView } from '@socio/foundation/operations/settings-view';
import type {
    ClassifyEvalReport,
    ClassifySettings,
    ClassifyUse,
    ClassifyUseSettings,
    ClassifyUseView,
} from '@socio/shared/classify';
import { INTENT_LABELS } from '@socio/shared/classify';
import type { OperationsSettings } from '@socio/shared/operations/operations';
import type { Settings } from '@socio/shared/types';

import type { InferenceShape } from '../inference/contract.js';
import { LEARNING_USE } from '../learning/contract.js';
import type { ModuleContext } from '../modules/contract.js';
import type { AccessAuditShape, RunSourceShape } from '../operations/contract.js';

import type { ClassifyConfigShape, ClassifyProvider } from './contract.js';
import { startEvaluation } from './eval.js';
import { FailureLabels, FAILURES_USE } from './failures.js';
import { ClassifyStore } from './infra/sqlite/store.js';
import { Classifier } from './seam.js';
import { intentUse, SessionLabels, THEMES_USE } from './sessions.js';
import { intentLabels, serverUseSettings, useSettings } from './settings.js';
import { ClassifyHost } from './tags.js';
import { workspaceProvider } from './workspace-provider.js';

/**
 * The seam as the app runs it (CB-198): its store, the providers that
 * ship (only `workspace`), the classifier, the `failures` use, sessions'
 * `intent` and `themes` (CB-199), Learning's definition (CB-200: its
 * triage runs in Learning, `learning/triage.ts`), and one evaluation at a
 * time.
 */
export class ClassifyService {
    readonly store: ClassifyStore;
    readonly classifier: Classifier;
    readonly failures: FailureLabels;
    readonly sessions: SessionLabels;
    private evaluation?: Promise<ClassifyEvalReport | undefined>;
    private abort?: AbortController;
    private starting = false;
    /** The use being evaluated, while one is. */
    private evaluated?: ClassifyUse;

    constructor(
        private deps: {
            db: DatabaseSync;
            /** The stored turns the labeling reads (Operations' `RunSource`). */
            runs: RunSourceShape;
            settings: () => Pick<Settings, 'classify' | 'operations'>;
            env?: ClassifySettings;
            /** The environment's Operations settings, for the session gap. */
            operations?: OperationsSettings;
            providers: readonly ClassifyProvider[];
            now?: () => number;
            log?: (line: string) => void;
        },
    ) {
        this.store = new ClassifyStore(deps.db);
        this.classifier = new Classifier({
            store: this.store,
            providers: deps.providers,
            definitions: (use) =>
                use === 'failures'
                    ? FAILURES_USE
                    : use === 'intent'
                      ? intentUse(this.intentLabels())
                      : use === 'learning'
                        ? LEARNING_USE
                        : THEMES_USE,
            settings: (use) => this.settings(use),
            now: deps.now,
            log: deps.log,
        });
        this.failures = new FailureLabels({
            db: deps.db,
            runs: deps.runs,
            store: this.store,
            classifier: this.classifier,
            now: deps.now,
            log: deps.log,
        });
        this.sessions = new SessionLabels({
            db: deps.db,
            runs: deps.runs,
            store: this.store,
            classifier: this.classifier,
            intentLabels: () => this.intentLabels(),
            sessionGapMinutes: () => operationsSettingsView(deps.settings(), deps.operations).sessionGapMinutes,
            now: deps.now,
            log: deps.log,
        });
    }

    /** Intent's labels in force: an admin's list, else `INTENT_LABELS`. */
    intentLabels() {
        return intentLabels(this.deps.settings());
    }

    settings(use: ClassifyUse): ClassifyUseSettings {
        return useSettings(this.deps.settings(), use, this.deps.env);
    }

    get evaluating() {
        return !!this.evaluation || this.starting;
    }

    /** Whether `use` is being evaluated. */
    evaluatingUse(use: ClassifyUse) {
        return this.evaluating && this.evaluated === use;
    }

    /**
     * Starts an evaluation of the use's provider in the background; false
     * when one (of any use) is running. Its refusals (no model, too few
     * labels) are thrown before it starts.
     */
    async evaluate(startedBy: string | null, use: ClassifyUse = 'failures') {
        if (this.evaluation || this.starting) {
            return false;
        }
        const abort = new AbortController();
        this.starting = true;
        this.evaluated = use;
        let report: Promise<ClassifyEvalReport>;
        try {
            ({ report } = await startEvaluation(
                {
                    classifier: this.classifier,
                    store: this.store,
                    intentLabels: () => this.intentLabels(),
                    now: this.deps.now,
                },
                use,
                { startedBy, signal: abort.signal },
            ));
        } finally {
            this.starting = false;
        }
        this.abort = abort;
        this.evaluation = report
            .catch((error: unknown) => {
                reportFailure(`Classify evaluation (${use})`, [safeFailure(error)]);
                return undefined;
            })
            .finally(() => {
                this.evaluation = undefined;
                this.abort = undefined;
            });
        return true;
    }

    /** Resolves when the running evaluation (if any) has ended (tests, stop). */
    async idle() {
        await this.evaluation;
    }

    async view(use: ClassifyUse): Promise<ClassifyUseView> {
        const settings = this.settings(use);
        const current = await this.classifier.current(use);
        const usage = this.store.usage(use, (this.deps.now ?? Date.now)());
        const { labelsVersion } = this.classifier.definition(use);
        return {
            use,
            ...settings,
            defaults: serverUseSettings(use, this.deps.env),
            available: !!current,
            version: current?.version ?? null,
            versionPassed: current ? this.classifier.passed(use, current.provider, current.version) : false,
            golden: this.store.goldenCount(use, labelsVersion),
            callsToday: usage.label,
            evalCallsToday: usage.eval,
            tokensToday: usage.tokens,
            costToday: usage.cost,
            unknownCostCalls: usage.unknown,
            evaluating: this.evaluatingUse(use),
            lastEval: this.store.latestEval(use, current?.version ?? null),
            labelsVersion,
            ...(use === 'intent'
                ? {
                      labels: this.intentLabels(),
                      defaultLabels: INTENT_LABELS.map((label) => ({ ...label })),
                  }
                : {}),
        };
    }

    /** At start: evaluations a stopped server left running end as failed. */
    async start() {
        await this.store.failRunningEvals();
    }

    async stop() {
        this.abort?.abort();
        await this.idle();
    }

    /** The labeling tick of each use; failures are reported, never thrown. */
    async tick() {
        try {
            await this.failures.tick();
        } catch (error) {
            reportFailure('Failure labels', [safeFailure(error)]);
        }
        for (const use of ['intent', 'themes'] as const) {
            try {
                await this.sessions.tickUse(use);
            } catch (error) {
                reportFailure(`Session labels (${use})`, [safeFailure(error)]);
            }
        }
    }
}

/**
 * The seam as the app runs it, from what it needs of other features: the
 * stored turns (`RunSource`), the settings, `ClassifyConfig`, and the
 * default shared backend (`Inference`), looked up per call, as titles use
 * it. `layer.ts` makes it from their tags.
 */
export function makeClassifyService(deps: {
    db: DatabaseSync;
    runs: RunSourceShape;
    settings: () => Pick<Settings, 'classify' | 'operations'>;
    config: ClassifyConfigShape;
    inference: () => Pick<InferenceShape, 'shared'>;
    log?: (line: string) => void;
}): ClassifyService {
    const endpoint: EndpointSource = async () => (await deps.inference().shared())?.chatCompletions;
    return new ClassifyService({
        db: deps.db,
        runs: deps.runs,
        settings: deps.settings,
        env: deps.config.classify,
        operations: deps.config.operations,
        providers: [workspaceProvider(endpoint)],
        log: deps.log,
    });
}

/** The seam and the access log its routes write to: what the module serves. */
export interface ClassifyParts {
    readonly service: ClassifyService;
    readonly audit: AccessAuditShape;
}

/**
 * The seam the app's services hold (`ClassifyHost`): the one the layer
 * graph made, or, on a platform built on its own, the one its own services
 * made, over the same connection, with Operations' `RunSource` and
 * `AccessAudit` (`composition/module-services.ts`). The module's hooks and
 * Learning's triage use it, so there is one per runtime, as there was one
 * per platform.
 */
export const classifyParts = (context: Pick<ModuleContext, 'services'>): ClassifyParts =>
    context.services.get(ClassifyHost);

/** The seam's service (`classifyParts`). */
export const classifyService = (context: Pick<ModuleContext, 'services'>): ClassifyService =>
    classifyParts(context).service;
