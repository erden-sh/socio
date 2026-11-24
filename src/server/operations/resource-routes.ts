import { Hono } from 'hono';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { operationsSettingsView } from '@socio/foundation/operations/settings-view';
import {
    COMPUTER_RESOURCE_METRICS,
    type ComputerResourceMetric,
    type ComputerResourceRow,
} from '@socio/shared/computers/computer-resources';
import { opsWindow, readOpsQuery } from '@socio/shared/operations/operations';
import { OPS_RETENTION, type ResourcePolicy } from '@socio/shared/operations/operations-resources';

import { Apps } from '../apps/contract.js';
import { ComputerRecords, Computers } from '../computers/contract.js';
import type { ModuleContext } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Audit, Socios } from '../workspace/contract.js';

import { OperationsConfig } from './contract.js';
import { deploymentResources } from './deployment-samples.js';
import { SqliteResourceSamples } from './infra/sqlite/samples.js';
import { resourcePolicyView } from './retention.js';

const retentionInput = z
    .object({
        ...Object.fromEntries(
            Object.keys(OPS_RETENTION).map((key) => [key, z.number().int().min(0).max(36500).nullable().optional()]),
        ),
        sampleEverySeconds: z.number().int().min(60).max(3600).multipleOf(60).nullable().optional(),
    })
    .strict();

/**
 * Admin-only through operationsModule; no raw paths, secrets or content in
 * metrics. It reads the computers' state, disk and the deployment's metrics
 * (`Computers`) and the apps' promotion attempts (out-of-memory kills,
 * `Apps`) when a request runs.
 */
export function resourceRoutes({ db, services }: ModuleContext) {
    // The workspace's settings, Operations' config, and the workspace's
    // socios, computers and audit, from the app's services.
    const store = services.get(WorkspaceSettings);
    const config = services.get(OperationsConfig);
    const socios = services.get(Socios);
    const audit = services.get(Audit);
    const workspace = {
        dots: () => socios.dots(),
        computers: services.get(ComputerRecords),
        audit: (...args: Parameters<typeof audit.audit>) => audit.audit(...args),
    };
    const app = new Hono<AppEnv>();
    const view = () => resourcePolicyView(store.settings().operations, config.operations?.resources);
    const samples = new SqliteResourceSamples(sqliteData(db));
    app.get('/operations/resources', async (c) =>
        c.json(await samples.history(Date.now(), view().policy.sampleEverySeconds)),
    );
    app.get('/operations/retention', (c) => c.json(view()));
    // The whole deployment's services (CB-321), apart from the host-wide numbers.
    app.get('/operations/resources/deployment', async (c) =>
        c.json(
            await deploymentResources({
                owner: services,
                metrics: services.get(Computers).deployment,
                data: sqliteData(db),
                now: Date.now(),
                intervalSeconds: view().policy.sampleEverySeconds,
            }),
        ),
    );
    app.get('/operations/resources/computers', async (c) => {
        const { query, invalid } = readOpsQuery(new URL(c.req.url).searchParams);
        if (invalid.length) {
            return c.json({ error: 'Invalid resource range or filters.' }, 400);
        }
        const now = Date.now();
        const window = opsWindow(query, {
            now,
            timeZone: operationsSettingsView(store.settings(), config.operations).timeZone,
            earliest: null,
        });
        const ooms = await services.get(Apps).promotions.attempts.oomsByDot(window.from ?? 0, window.to);
        const rows: ComputerResourceRow[] = [];
        let more = false;
        for (const dot of workspace.dots()) {
            if (
                (query.filters.socio && dot.id !== query.filters.socio) ||
                (query.filters.space && !(dot.spaceIds ?? [dot.spaceId]).includes(query.filters.space))
            ) {
                continue;
            }
            const history = await new SqliteResourceSamples<ComputerResourceMetric>(
                sqliteData(db),
                dot.id,
                COMPUTER_RESOURCE_METRICS,
            ).history(now, view().policy.sampleEverySeconds);
            const oom = ooms.find((row) => row.dotId === dot.id);
            const permissions = await workspace.computers.permissions(dot.id);
            if (!permissions.enabled && !history.latest && !oom) {
                continue;
            }
            if (rows.length === 100) {
                more = true;
                break;
            }
            rows.push({
                dotId: dot.id,
                name: dot.name,
                running: services.get(Computers).resourceState(dot.id),
                history,
                appOoms: oom?.count ?? 0,
                lastAppOomAt: oom?.lastAt ?? null,
            });
        }
        return c.json({
            rows,
            more,
            from: window.from,
            to: window.to,
            disk: services.get(Computers).diskStatus(),
        });
    });
    app.put('/operations/retention', async (c) => {
        const input = retentionInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json(
                {
                    error: 'Retention is whole days from 0 to 36500 (0 keeps history); sampling is 60 to 3600 seconds in whole minutes. Use null for the server default.',
                },
                400,
            );
        }
        if (!Object.keys(input.data).length) {
            return c.json(view());
        }
        await sqliteData(db).uow.run(
            async () => {
                const operations = store.settings().operations ?? {};
                const before = view().policy;
                const resources = { ...operations.resources };
                const analytics = { ...operations.analytics };
                let changed = false;
                for (const [name, value] of Object.entries(input.data)) {
                    const key = name as keyof ResourcePolicy;
                    if (value === undefined) {
                        continue;
                    }
                    const target: Partial<ResourcePolicy> =
                        key === 'factDays' || key === 'hourlyDays' ? analytics : resources;
                    // Inheritance is meaningful even when its effective value equals an
                    // override. Empty maps and object key order are not policy changes.
                    if (value === null) {
                        if (Object.hasOwn(target, key)) {
                            delete target[key];
                            changed = true;
                        }
                    } else if (!Object.hasOwn(target, key) || target[key] !== value) {
                        target[key] = value;
                        changed = true;
                    }
                }
                if (!changed) {
                    return;
                }
                const next = { ...operations };
                if (Object.keys(resources).length) {
                    next.resources = resources;
                } else {
                    delete next.resources;
                }
                if (Object.keys(analytics).length) {
                    next.analytics = analytics;
                } else {
                    delete next.analytics;
                }
                await store.updateSettings({ operations: next });
                const after = view().policy;
                workspace.audit({
                    actor: c.get('user').id,
                    action: 'update',
                    targetKind: 'operations_settings',
                    targetId: 'retention',
                    detail: JSON.stringify({ before, after, change: input.data }),
                });
            },
            { label: 'change operations retention' },
        );
        return c.json(view());
    });
    return app;
}
