import type { AppStatus } from '@socio/shared/apps/app-types';

/**
 * Whether the workspace app runtime serves the app: promoted and
 * unpublished apps run there; development apps run on their Dot's computer.
 */
export function appInRuntime(app: { status: AppStatus }) {
    return app.status === 'promoted' || app.status === 'unpublished';
}
