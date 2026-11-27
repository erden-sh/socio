/**
 * `@socio/i18n/react`: the React binding. Components take `t` from
 * `useTranslation()` (never a module-level `i18n.t`: the React Compiler
 * memoizes values, and a captured `t` doesn't follow a language change),
 * and rich text through `<Trans>`.
 */
import { initReactI18next } from 'react-i18next';

import { createI18n, type CreateI18nOptions } from './create.js';

export { I18nextProvider, Trans, useTranslation } from 'react-i18next';

/** `createI18n` for React: bound to react-i18next, no HTML escaping (React escapes). */
export function createReactI18n(options: Omit<CreateI18nOptions, 'escapeValue'>) {
    return createI18n({
        ...options,
        escapeValue: false,
        // A route's namespaces come with its loader data (inlined), and a new
        // language switches once its files are in: nothing suspends.
        react: { useSuspense: false, ...options.react },
        plugins: [...(options.plugins ?? []), initReactI18next],
    });
}
