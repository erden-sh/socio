// The app's three builds, chosen by
// APP_VARIANT when app.config.ts is read. Each has its own name, bundle id and
// URL scheme, so all three install side by side. Unset means development; any
// other value throws, so a typo fails the build instead of shipping another
// variant's id.
export const VARIANTS = {
    development: { name: 'Socio Dev', id: 'com.ingenioventures.socio.dev', scheme: 'socio-dev' },
    preview: { name: 'Socio Preview', id: 'com.ingenioventures.socio.preview', scheme: 'socio-preview' },
    production: { name: 'Socio', id: 'com.ingenioventures.socio', scheme: 'socio' },
} as const;

export type VariantName = keyof typeof VARIANTS;

export interface Variant {
    variant: VariantName;
    /** What the home screen shows under the icon. */
    name: string;
    /** The iOS bundle identifier and the Android application id. */
    id: string;
    scheme: string;
}

export const isVariantName = (value: string): value is VariantName => Object.hasOwn(VARIANTS, value);

/** The variant APP_VARIANT names. An empty value counts as unset, as a shell's `APP_VARIANT=` does. */
export function appVariant(value: string | undefined): Variant {
    const name = value || 'development';
    if (!isVariantName(name)) {
        throw new Error(`Unknown APP_VARIANT "${value}": use ${Object.keys(VARIANTS).join(', ')}, or leave it unset.`);
    }
    return { variant: name, ...VARIANTS[name] };
}
