import { useState } from 'react';

import { FIXTURE_CONTEXT } from '@socio/shared/dataset-views/fixtures/index';
import { browserTimeZone } from '@socio/shared/time-zone';

import { useWorkspaceScope } from '../live';
import { type CellFormat, todayIn } from '../shell/dataset-view';
import { createFixtureViewSource, dayIn } from '../sync/fixture-source';
import { createLiveViewSource, type ViewSource } from '../sync/view-source';

// The dataset screens' one `ViewSource` (CB-469): the workspace's routes, or,
// for the dev preview (`preview`), the shared fixtures, one source for the
// app's run so drafts, edits, uploads and new rows last across the screens
// (the view, its fields, New row) while it runs. The fixtures' zone and day
// come with them.

let previewSource: ViewSource | null = null;
const fixtureSource = () => (previewSource ??= createFixtureViewSource());

export function useViewSource(preview: boolean): ViewSource {
    const scope = useWorkspaceScope();
    const [live] = useState(() => createLiveViewSource({ fetch: scope.fetch, signal: scope.signal }));
    return preview ? fixtureSource() : live;
}

/** How cells are formatted, and today, for the live workspace or the fixtures. */
export function datasetFormat(preview: boolean): { format: CellFormat; today: string } {
    const format: CellFormat = { timeZone: preview ? FIXTURE_CONTEXT.timeZone : (browserTimeZone() ?? 'UTC') };
    const today = preview
        ? (dayIn(FIXTURE_CONTEXT.now, FIXTURE_CONTEXT.timeZone) ?? '2026-11-21')
        : todayIn(format.timeZone);
    return { format, today };
}
