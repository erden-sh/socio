import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { hasLanguageChoice } from '@socio/i18n/manifest';
import { negotiateLocale } from '@socio/i18n/negotiate';
import { useTranslation } from '@socio/i18n/react';
import { languageName } from '@socio/shared/locale';

import { usePageInstance, usePageLocale } from '../../../i18n/I18nRoot';
import { applyLocale } from '../../../i18n/page-instance';
import { useShell } from '../../../shell/shell-context';
import { SettingsCard } from '../AccountSettings';

/** The browser's languages, best first; none on the server. */
const browserLanguages = () =>
    typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];

/**
 * Settings › Account › Language: the language Socio shows this person on
 * this server, saved as their preference (`PATCH /api/preferences`,
 * `locale`) and applied at once, without a reload. "Match my device"
 * (null) follows the browser's languages. Each language is named in its
 * own language. Only the locales over the coverage gate are offered, and
 * with one alone the section doesn't render.
 *
 * The reference for translated UI (docs/I18N.md): every word comes from
 * `t()`, and `socio/no-literal-text` holds this folder to it.
 */
export function LanguageSection() {
    const { offered } = usePageLocale();
    if (!hasLanguageChoice(offered)) {
        return null;
    }
    return <LanguagePicker offered={offered} />;
}

function LanguagePicker({ offered }: { offered: readonly string[] }) {
    const { t, i18n } = useTranslation(['settings.language']);
    const page = usePageInstance();
    const { workspace, mutate } = useShell();
    const saved = workspace.preferences?.locale ?? null;
    const [value, setValue] = useState<string | null>(saved);
    useEffect(() => setValue(saved), [saved]);
    // The device's match is the browser's: known only after hydration.
    const [device, setDevice] = useState<string>();
    useEffect(() => setDevice(negotiateLocale(browserLanguages(), offered)), [offered]);
    // While a choice saves and applies, the list waits; and only the latest
    // choice applies, should one start before the last one finished.
    const [busy, setBusy] = useState(false);
    const saves = useRef(0);
    const save = async (next: string | null) => {
        const mine = ++saves.current;
        const previous = value;
        setValue(next);
        setBusy(true);
        try {
            if (!(await mutate('/preferences', 'PATCH', { locale: next }))) {
                if (mine === saves.current) {
                    setValue(previous);
                }
                return;
            }
            if (mine !== saves.current) {
                return;
            }
            const locale = next ?? negotiateLocale(browserLanguages(), offered);
            if (!(await applyLocale(page, locale, next)) || mine !== saves.current) {
                return;
            }
        } finally {
            if (mine === saves.current) {
                setBusy(false);
            }
        }
        toast.success(
            next
                ? t('settings.language:saved', { language: languageName(next, next) })
                : t('settings.language:savedDevice'),
        );
    };
    return (
        <SettingsCard>
            <fieldset className="grid gap-3" data-slot="language-preference" aria-busy={busy}>
                <legend className="mb-1 font-medium">{t('settings.language:title')}</legend>
                <p className="text-muted-foreground">{t('settings.language:description')}</p>
                <label className="flex items-start gap-2">
                    <input
                        type="radio"
                        name="language"
                        data-slot="radio"
                        className="mt-1"
                        checked={value === null}
                        disabled={busy}
                        onChange={() => void save(null)}
                    />
                    <span className="font-medium">
                        {device
                            ? t('settings.language:matchDeviceCurrently', {
                                  language: languageName(device, i18n.language),
                              })
                            : t('settings.language:matchDevice')}
                    </span>
                </label>
                {offered.map((locale) => (
                    <label key={locale} className="flex items-start gap-2">
                        <input
                            type="radio"
                            name="language"
                            data-slot="radio"
                            className="mt-1"
                            checked={value === locale}
                            disabled={busy}
                            onChange={() => void save(locale)}
                        />
                        <span className="font-medium" lang={locale}>
                            {languageName(locale, locale)}
                        </span>
                    </label>
                ))}
            </fieldset>
        </SettingsCard>
    );
}
