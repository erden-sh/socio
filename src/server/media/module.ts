import { Approvals } from '../approvals/contract.js';
import type { ServerModule } from '../modules/contract.js';

import { SPACE_UPLOAD_LIMITS } from './contract.js';
import { mediaSchema } from './migrations.js';
import { mediaRoutes } from './routes.js';
import { SPACE_MEDIA_TOOL_NAMES, spaceUploadTools } from './space-upload.js';
import { MediaServiceTag } from './tags.js';
import { ATTACHMENT_TOOL_NAMES, attachmentTools } from './tools.js';

const MB = 1048576;

/**
 * Chat attachments (CB-54 step 2). The service lives on the platform
 * (`platform.media`, which turn resolution uses); the module owns its
 * table, the `/api/media` routes, the `attachments` capability and tool,
 * and the hourly clean-up of attachments never sent.
 *
 * Its hooks reach only media's own service (`MediaServiceTag`, the very object
 * the media layer provides as `Media`), from the app's services at the moment
 * of use; the data space's limits come through it (`media.data`), so the
 * module needs no other feature (`platform-needs.ts` is gone). The hooks stay
 * synchronous or promise-returning, as the registry calls them.
 */
export const mediaModule: ServerModule = {
    ...mediaSchema,
    routes: ({ services }) => mediaRoutes(services.get(MediaServiceTag)),
    dotTools: ({ services }, turn) => [
        ...attachmentTools(services.get(MediaServiceTag), turn),
        // Uploads into a Space's media (CB-524), on the person's approval.
        ...spaceUploadTools({ media: services.get(MediaServiceTag), approvals: services.get(Approvals), turn }),
    ],
    capabilities: ({ services }) => [
        {
            id: 'attachments',
            label: 'Attachments',
            description:
                'Files the user attached in this conversation: readable without a grant (files_get with the path from the note, or attachments_list). Files elsewhere in the user’s data space need a folder grant: ask with data_request_access.',
            tools: ATTACHMENT_TOOL_NAMES,
            status: async (turn) => {
                const media = services.get(MediaServiceTag);
                const rows = await media.forThread(turn.threadId);
                return {
                    enabled: true,
                    limits: {
                        imagesShownPerTurn: turn.maxImages ?? null,
                        imageMaxMB: media.imageModelMaxBytes / MB,
                        fileMaxMB: media.data.limits.fileMaxBytes / MB,
                    },
                    usage: {
                        attachments: rows.length,
                        totalMB: Math.round((rows.reduce((sum, row) => sum + row.size, 0) / MB) * 100) / 100,
                    },
                };
            },
        },
        {
            id: 'space_media',
            label: 'Space media',
            description:
                'Upload images and PDFs you may read into the media of a Space the person edits, so its readers can open them (an import’s assets). New files need the person’s approval under their policy; the same content again returns the same asset.',
            tools: SPACE_MEDIA_TOOL_NAMES,
            status: async () => ({
                enabled: true,
                limits: {
                    imageMaxMB: SPACE_UPLOAD_LIMITS.imageMaxBytes / MB,
                    pdfMaxMB: SPACE_UPLOAD_LIMITS.pdfMaxBytes / MB,
                    filesPerCall: SPACE_UPLOAD_LIMITS.filesPerCall,
                    unreferencedKeptDays: SPACE_UPLOAD_LIMITS.graceMs / 86_400_000,
                },
            }),
        },
    ],
    tick: {
        everyMs: 60 * 60_000,
        run: ({ services, log }) => {
            void services
                .get(MediaServiceTag)
                .collectPending()
                .then((removed) => {
                    if (removed) {
                        log(`Media: deleted ${removed} attachment(s) never sent.`);
                    }
                })
                .catch(() => log('Media: deleting unsent attachments failed.'));
            // Space uploads no page names, past their grace (CB-524).
            void services
                .get(MediaServiceTag)
                .collectSpaceUploads()
                .then((removed) => {
                    if (removed) {
                        log(`Media: removed ${removed} Space upload(s) no page names.`);
                    }
                })
                .catch(() => log('Media: cleaning up Space uploads failed.'));
        },
    },
};
