/**
 * `POST /api/data/specs/validate` (CB-451): a query spec checked
 * for the person asking, against the live table of a dataset they may
 * read, with every problem at once. No query runs.
 */
import type { DatasetDetail } from '@socio/shared/data-types';
import type { FieldSetting } from '@socio/shared/dataset-query/kinds';
import type { SpecValidateBody, SpecValidation } from '@socio/shared/dataset-query/spec';

import { checkSpec, parseSpec } from './check.js';

export interface SpecSources {
    /** The dataset and its tables, through the person's own read access (404 otherwise). */
    detailFor(userId: string, datasetId: string): DatasetDetail;
    /** The table's field settings; none without it. */
    fieldSettings?(datasetId: string, table: string): FieldSetting[];
}

export function validateSpec(sources: SpecSources, userId: string, body: SpecValidateBody): SpecValidation {
    const { spec, problems } = parseSpec(body.spec);
    if (!spec) {
        return { ok: false, problems };
    }
    const source = spec.source;
    if (!('dataset' in source)) {
        // Plugin data sources aren't built yet.
        return {
            ok: false,
            problems: [{ path: '$.source', message: 'Plugin data sources aren’t available yet; use a dataset table.' }],
        };
    }
    // Throws the data space's own 404 when the person can't read it.
    const detail = sources.detailFor(userId, source.dataset);
    const table = detail.tables.find((t) => t.name === source.table);
    if (!table) {
        return {
            ok: false,
            problems: [
                {
                    path: '$.source.table',
                    message: `Dataset "${detail.dataset.name}" has no table "${source.table.slice(0, 80)}".`,
                },
            ],
        };
    }
    const check = checkSpec(body.spec, {
        table,
        settings: sources.fieldSettings?.(source.dataset, source.table),
        params: body.params,
    });
    return check.ok ? { ok: true, problems: [], engine: check.engine } : { ok: false, problems: check.problems };
}
