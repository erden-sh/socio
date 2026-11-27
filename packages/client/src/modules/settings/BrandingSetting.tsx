import { useTranslation } from '@socio/i18n/react';
import { BRAND_LOGO_MAX_BYTES, DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const readLogo = (file: File) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read logo.'));
        reader.readAsDataURL(file);
    });

/**
 * Public identity, owned by the admins and persisted with workspace
 * settings. It saves as it changes (CB-308): the logo as soon as a file is
 * picked, the name when its field loses focus. `custom` is whether the
 * workspace has its own branding, so that Undo of the first change goes
 * back to the deployment's defaults rather than saving them as its own.
 */
export function BrandingSetting({
    branding,
    mutate,
}: {
    branding?: Branding | null;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave(
        {
            name: branding?.name ?? DEFAULT_BRANDING.name,
            logo: branding?.logo ?? DEFAULT_BRANDING.logo,
            custom: !!branding,
        },
        ({ name, logo, custom }) =>
            mutate('/settings', 'PATCH', {
                branding: custom ? { name: name.trim(), logo } : null,
            }),
    );
    const commitName = () => {
        const saved = auto.saved();
        const name = auto.value.name.trim();
        // Typed back to what is saved: nothing to save.
        const unchanged = name === saved.name && auto.value.logo === saved.logo;
        auto.edit({ name, custom: unchanged ? saved.custom : true });
        void auto.commit(t('settings.workspace:branding.nameSaved'), (value) =>
            value.name ? undefined : t('settings.workspace:branding.nameRequired'),
        );
    };
    return (
        <SettingsCard>
            <form
                className="grid min-w-0 gap-4"
                data-slot="workspace-branding"
                // Enter in the name saves too, like leaving it.
                onSubmit={(event) => {
                    event.preventDefault();
                    commitName();
                }}
            >
                <AutosaveHeader title={t('settings.workspace:branding.title')} status={auto.status}>
                    {t('settings.workspace:branding.intro')}
                </AutosaveHeader>
                <label className="grid gap-2">
                    {t('settings.workspace:branding.name')}
                    <Input
                        id="branding-name"
                        value={auto.value.name}
                        onChange={(event) => auto.edit({ name: event.target.value })}
                        onBlur={commitName}
                        maxLength={100}
                        placeholder={t('settings.workspace:branding.namePlaceholder')}
                    />
                </label>
                <img
                    src={auto.value.logo}
                    alt={t('settings.workspace:branding.logoPreview')}
                    className="size-16 object-contain"
                />
                <label className="grid gap-2">
                    {t('settings.workspace:branding.logo')}
                    <Input
                        id="branding-logo"
                        type="file"
                        accept={LOGO_TYPES.join(',')}
                        onChange={async (event) => {
                            const input = event.currentTarget;
                            const file = input.files?.[0];
                            if (!file) {
                                return;
                            }
                            // The same file can be picked again after an Undo.
                            input.value = '';
                            if (!LOGO_TYPES.includes(file.type) || file.size > BRAND_LOGO_MAX_BYTES) {
                                auto.setError(t('settings.workspace:branding.logoInvalid'));
                                return;
                            }
                            let logo: string;
                            try {
                                logo = await readLogo(file);
                            } catch {
                                auto.setError(t('settings.workspace:branding.logoUnreadable'));
                                return;
                            }
                            void auto.change({ logo, custom: true }, t('settings.workspace:branding.logoSaved'));
                        }}
                    />
                </label>
                <p className="text-sm text-muted-foreground">{t('settings.workspace:branding.logoHint')}</p>
                <SaveError error={auto.error} />
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={auto.value.logo === DEFAULT_BRANDING.logo}
                        onClick={() =>
                            void auto.change(
                                { logo: DEFAULT_BRANDING.logo, custom: true },
                                t('settings.workspace:branding.productLogoSaved'),
                            )
                        }
                    >
                        {t('settings.workspace:branding.useProductLogo')}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!auto.value.custom}
                        onClick={() =>
                            void auto.change(
                                { ...DEFAULT_BRANDING, custom: false },
                                t('settings.workspace:branding.defaultsSaved'),
                            )
                        }
                    >
                        {t('settings.workspace:branding.useDefaults')}
                    </Button>
                </div>
            </form>
        </SettingsCard>
    );
}
