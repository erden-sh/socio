/** Public workspace identity, also shown before sign-in. */
export interface Branding {
    name: string;
    /** Same-origin asset path or an uploaded PNG, JPEG or WebP data URL. */
    logo: string;
}
export const DEFAULT_BRANDING: Branding = {
    name: 'Socio',
    logo: '/favicon.svg',
};
export const BRAND_LOGO_MAX_BYTES = 256 * 1024;
