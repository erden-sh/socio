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
        void auto.commit('Workspace name saved', (value) =>
            value.name ? undefined : 'Name the workspace: it shows in navigation and on sign-in.',
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
                <AutosaveHeader title="Workspace branding" status={auto.status}>
                    The name and logo shown in navigation and on sign-in.
                </AutosaveHeader>
                <label className="grid gap-2">
                    Display name
                    <Input
                        id="branding-name"
                        value={auto.value.name}
                        onChange={(event) => auto.edit({ name: event.target.value })}
                        onBlur={commitName}
                        maxLength={100}
                        placeholder="Client Company Brain"
                    />
                </label>
                <img src={auto.value.logo} alt="Logo preview" className="size-16 object-contain" />
                <label className="grid gap-2">
                    Client logo
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
                                auto.setError('Choose a PNG, JPEG or WebP image up to 256 KB.');
                                return;
                            }
                            let logo: string;
                            try {
                                logo = await readLogo(file);
                            } catch {
                                auto.setError('Could not read logo. Please retry.');
                                return;
                            }
                            void auto.change({ logo, custom: true }, 'Logo saved');
                        }}
                    />
                </label>
                <p className="text-sm text-muted-foreground">
                    PNG, JPEG or WebP, up to 256 KB. Stored in this workspace. A logo saves as soon as you pick it.
                </p>
                <SaveError error={auto.error} />
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={auto.value.logo === DEFAULT_BRANDING.logo}
                        onClick={() =>
                            void auto.change({ logo: DEFAULT_BRANDING.logo, custom: true }, 'Socio logo in use')
                        }
                    >
                        Use Socio logo
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!auto.value.custom}
                        onClick={() =>
                            void auto.change(
                                { ...DEFAULT_BRANDING, custom: false },
                                'Back to the deployment’s branding',
                            )
                        }
                    >
                        Use deployment defaults
                    </Button>
                </div>
            </form>
        </SettingsCard>
    );
}
