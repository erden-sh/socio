import { z } from 'zod';

import { BRAND_LOGO_MAX_BYTES } from '../branding.js';

export const brandingSchema = z
    .object({
        name: z.string().trim().min(1).max(100),
        logo: z
            .string()
            .max(Math.ceil(BRAND_LOGO_MAX_BYTES / 3) * 4 + 64)
            .refine(
                (value) =>
                    /^\/(?!\/)[^\\\s?#]*$/.test(value) ||
                    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value),
                'Use a same-origin asset path or upload a PNG, JPEG or WebP logo.',
            ),
    })
    .strict();
