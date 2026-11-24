import { DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';
import { brandingSchema } from '@socio/shared/settings/branding';

/** Saved operator choices override deployment defaults. Null resets to defaults. */
export function brandingInForce(saved?: Branding | null, env = process.env): Branding {
    return (
        saved ??
        brandingSchema.parse({
            name: env.BRAND_NAME?.trim() || DEFAULT_BRANDING.name,
            logo: env.BRAND_LOGO?.trim() || DEFAULT_BRANDING.logo,
        })
    );
}
