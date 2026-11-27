import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createReactI18n } from '@socio/i18n/react';

// The client's tests render components on their own, outside the page's
// I18nRoot: this en-US instance, with every namespace, is the one their
// useTranslation() falls back to (react-i18next's default instance), so
// they read the source strings. A test that renders through I18nRoot gets
// that page's instance instead. Whether a route inlines what its page
// needs is settings-pseudo-locale.test.tsx's job, not this file's.
const dir = join(import.meta.dirname, '../../../i18n/locales/en-US');
const resources = Object.fromEntries(
    readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(join(dir, name), 'utf8'))]),
);

createReactI18n({ locale: 'en-US', resources: { 'en-US': resources }, namespaces: Object.keys(resources) });
