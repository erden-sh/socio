import SETTINGS from '@socio/i18n/locales/en-US/settings.json';

import type { SettingsEntry } from './sections';

/**
 * The breadcrumbs' words. A crumb is a plain string the shell draws and
 * titles the page with (`Crumb.label`), built outside React, where there is
 * no `t()`; until the shell translates crumbs, they read en-US's words from
 * the `settings` namespace, so the copy lives in one place.
 */
export const SETTINGS_CRUMB = SETTINGS.title;
export const sectionCrumb = (id: SettingsEntry['id'] | undefined) => (id ? SETTINGS.sections[id] : SETTINGS.title);
export const PERSON_CRUMB = SETTINGS.crumbs.person;
