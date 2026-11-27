/** The dictionaries at the HTTP edge: public, before the body limit and the session check. */
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { I18nCatalogShape } from '../../i18n/contract.js';
import { i18nRoutes } from '../../i18n/routes.js';
import { processI18nCatalog } from '../i18n.js';

/** `/i18n/manifest.json` and `/i18n/<locale>/<ns>.<hash>.json` (i18n/routes.ts). */
export function mountI18nRoutes(app: Hono<AppEnv>, catalog: I18nCatalogShape = processI18nCatalog()) {
    app.route('/i18n', i18nRoutes(catalog));
}

export const i18nHttpRoutes = { routes: mountI18nRoutes };
