/**
 * Typed keys (docs/I18N.md): `t('settings.language:title')` is checked
 * against the en-US source, and so are its variables
 * (`strictInterpolationChecks`). The resources are en-US's strings as
 * literal types, generated from the JSON (`pnpm run i18n:types`; the build
 * fails while the file is stale).
 */
import type { EnglishResources } from '@socio/i18n/resources.gen';

declare module 'i18next' {
    interface CustomTypeOptions {
        defaultNS: 'common';
        resources: EnglishResources;
        returnNull: false;
        returnEmptyString: false;
        strictInterpolationChecks: true;
    }
}
