import { Images } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/**
 * Media (CB-54): the user's files and chat attachments, a view over the
 * data space's files. Browse by folder, preview, upload, move, delete,
 * see which conversation a file came from, and which Dots may read a
 * folder (the data space's folder grants).
 */
export const mediaModule: ClientModule = {
    id: MODULE_IDS.media,
    title: 'Media',
    description: 'Your files and chat attachments, and which socios can read them.',
    icon: Images,
    tone: 'sky',
    order: 46,
    opens: { path: '/media' },
    sidebar: 'workspace',
};
