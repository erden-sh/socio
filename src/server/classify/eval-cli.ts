// pnpm run classify:eval -- --use=failures --provider=workspace
//
// Evaluates a provider version of a classification use (failures, intent,
// themes or learning) against its golden set (CB-198 to CB-200): the admins' labels in DATABASE_PATH (or --database=), each
// given to the provider again. Prints per-label precision and recall and
// the confusion matrix, and records the evaluation as Operations' Evaluate
// button does: a pass applies the version's sure labels. It calls the
// workspace's default shared model, read from the database (with
// DATA_ENCRYPTION_KEY or SESSION_SECRET to open its key), so it costs what
// one call per golden label costs. Exits 0 when the version passed, 2 when
// it didn't, 1 when it couldn't run.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { planMigrations } from '@socio/data/migrate';
import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { dataKeysFromEnv } from '@socio/foundation/keys/data-keys';
import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import { CLASSIFY_USES, type ClassifyEvalReport, type ClassifyUse } from '@socio/shared/classify';
import { formatNumber } from '@socio/shared/locale';
import type { Settings } from '@socio/shared/types';

import { InferenceService } from '../inference/service.js';
import { schemas } from '../modules/index.js';
import { sqliteSourceReader } from '../operations/infra/sqlite/source-reader.js';

import { EvalRefused, evaluateUse } from './eval.js';
import { ClassifyService } from './service.js';
import { classifySettingsFromEnv } from './settings.js';
import { workspaceProvider } from './workspace-provider.js';

export interface EvalCliArgs {
    use: ClassifyUse;
    provider?: string;
    database: string;
}

export function parseEvalArgs(
    argv: readonly string[],
    env: Record<string, string | undefined> = process.env,
): EvalCliArgs {
    const args: Record<string, string> = {};
    for (const arg of argv) {
        if (arg === '--') {
            continue;
        }
        const match = /^--([a-z]+)=(.*)$/.exec(arg);
        if (!match) {
            throw new Error(
                `Unknown argument ${arg}. Use --use=${CLASSIFY_USES.join('|')} [--provider=workspace] [--database=path].`,
            );
        }
        args[match[1]!] = match[2]!;
    }
    const use = args.use ?? 'failures';
    if (!(CLASSIFY_USES as readonly string[]).includes(use)) {
        throw new Error(`There is no use ${use}; there is ${CLASSIFY_USES.join(', ')}.`);
    }
    for (const name of Object.keys(args)) {
        if (!['use', 'provider', 'database'].includes(name)) {
            throw new Error(`Unknown option --${name}.`);
        }
    }
    return {
        use: use as ClassifyUse,
        ...(args.provider ? { provider: args.provider } : {}),
        database: args.database ?? env.DATABASE_PATH ?? 'data/company-brain.sqlite',
    };
}

const share = (value: number | null) => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);

/** The report as text: totals, per-label scores and the confusion matrix. */
export function formatEvalReport(report: ClassifyEvalReport) {
    const lines = [
        `${report.use} on ${report.version} (labels v${report.labelsVersion}), threshold ${report.threshold}`,
        `Golden set: ${formatNumber(report.golden)} · answered: ${formatNumber(report.answered)} · precision of answers: ${share(report.precision)} · accuracy: ${share(report.accuracy)} · failed calls: ${formatNumber(report.failedCalls)}`,
        report.status === 'failed'
            ? `Failed: ${report.error ?? 'unknown'}`
            : report.passed
              ? 'Passed: its sure labels are applied.'
              : 'Did not pass: its labels stay suggestions.',
        '',
    ];
    const labels = report.labels.map((score) => score.label);
    const width = Math.max(...labels.map((label) => label.length), 5);
    lines.push(`${'label'.padEnd(width)}  support  predicted  correct  precision  recall`);
    for (const score of report.labels) {
        lines.push(
            `${score.label.padEnd(width)}  ${String(score.support).padStart(7)}  ${String(score.predicted).padStart(9)}  ${String(score.correct).padStart(7)}  ${share(score.precision).padStart(9)}  ${share(score.recall).padStart(6)}`,
        );
    }
    lines.push('', 'Confusion (rows: admin label, columns: model):');
    const short = (label: string) => label.slice(0, 8).padStart(8);
    lines.push(`${''.padEnd(width)}  ${labels.map(short).join(' ')}`);
    for (const gold of labels) {
        lines.push(
            `${gold.padEnd(width)}  ${labels
                .map((predicted) => String(report.confusion[gold]?.[predicted] ?? 0).padStart(8))
                .join(' ')}`,
        );
    }
    return lines.join('\n');
}

export async function runEvalCli(
    argv: readonly string[],
    env: Record<string, string | undefined> = process.env,
    out: (line: string) => void = (line) => console.log(line),
    fetchImpl?: typeof fetch,
) {
    loadSecretFiles(env, undefined, ['SESSION_SECRET', 'DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY_PREVIOUS']);
    const args = parseEvalArgs(argv, env);
    const db = new DatabaseSync(args.database);
    try {
        applyConnectionPragmas(db, env);
        if (planMigrations(db, schemas, { strict: true }).length) {
            throw new EvalRefused('This database isn’t on this release’s schema: start the app with it once first.');
        }
        const row = db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string } | undefined;
        const settings = JSON.parse(row?.value ?? '{}') as Settings;
        const inference = new InferenceService(db, {
            secret: {
                ...dataKeysFromEnv(env),
                legacy: env.SESSION_SECRET?.trim() || randomBytes(32).toString('base64url'),
            },
            log: () => {},
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        const service = new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            env: classifySettingsFromEnv(env),
            providers: [workspaceProvider(async () => (await inference.shared())?.chatCompletions, fetchImpl)],
        });
        if (args.provider && !(await service.classifier.current(args.use, args.provider))) {
            throw new EvalRefused(
                `There is no provider ${args.provider} set up; this release ships workspace, the workspace's default shared model.`,
            );
        }
        const report = await evaluateUse(
            {
                classifier: service.classifier,
                store: service.store,
                intentLabels: () => service.intentLabels(),
            },
            args.use,
            {
                provider: args.provider,
                onProgress: (done, total) => {
                    if (done % 10 === 0 || done === total) {
                        out(`${done} of ${total} asked`);
                    }
                },
            },
        );
        out(formatEvalReport(report));
        return report.status === 'done' && report.passed ? 0 : report.status === 'done' ? 2 : 1;
    } finally {
        db.close();
    }
}
