import { createInstance, type i18n, type InitOptions, type Module, type Newable, type Resource } from 'i18next';

import { setActiveLocale } from '@socio/shared/locale';

import { addFormatters } from './format.js';
import { SOURCE_LOCALE, fallbackLanguages } from './registry.js';

/** The namespace a key without `ns:` reads. */
export const DEFAULT_NAMESPACE = 'common';

export interface CreateI18nOptions {
    /** The locale to render in (negotiated: `resolveRequestLocale`). */
    locale: string;
    /** Dictionaries at hand: `resources[locale][ns]`. */
    resources?: Resource;
    /** The namespaces to load at once; the default namespace when unset. */
    namespaces?: readonly string[];
    /** Loads what `resources` lacks (the web's http backend, the app's own). */
    backend?: Module | Newable<Module>;
    backendOptions?: InitOptions['backend'];
    /** More plugins: `initReactI18next` (`@socio/i18n/react`). */
    plugins?: readonly (Module | Newable<Module>)[];
    /**
     * Whether interpolated values are HTML-escaped. On (the default) for
     * text that isn't React's: email, Telegram. React escapes itself, so
     * `@socio/i18n/react` turns it off.
     */
    escapeValue?: boolean;
    /** Makes this instance's language the one `@socio/shared/locale` formats in (the browser's one instance). */
    drivesActiveLocale?: boolean;
    /** Plugin settings (`react` for react-i18next). */
    react?: InitOptions['react'];
}

/**
 * An i18next instance with Socio's settings: en-US fallback through each
 * locale's chain, no empty strings, Socio's formatters. Initialized at once
 * from `resources` (no await needed); what a backend loads comes later.
 * One per request on the server, one per page in the browser.
 */
export function createI18n(options: CreateI18nOptions): i18n {
    const instance = createInstance();
    if (options.backend) {
        instance.use(options.backend);
    }
    for (const plugin of options.plugins ?? []) {
        instance.use(plugin);
    }
    if (options.drivesActiveLocale) {
        instance.on('languageChanged', (locale) => setActiveLocale(locale));
    }
    const namespaces = options.namespaces?.length ? [...options.namespaces] : [DEFAULT_NAMESPACE];
    void instance.init({
        lng: options.locale,
        fallbackLng: fallbackLanguages(),
        load: 'currentOnly',
        ns: namespaces,
        defaultNS: DEFAULT_NAMESPACE,
        fallbackNS: false,
        resources: options.resources,
        partialBundledLanguages: !!options.backend,
        backend: options.backendOptions,
        initAsync: false,
        returnNull: false,
        returnEmptyString: false,
        returnObjects: false,
        saveMissing: false,
        interpolation: { escapeValue: options.escapeValue ?? true },
        ...(options.react && { react: options.react }),
    });
    addFormatters(instance);
    if (options.drivesActiveLocale) {
        setActiveLocale(options.locale);
    }
    return instance;
}

export { SOURCE_LOCALE };
