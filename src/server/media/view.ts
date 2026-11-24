import { MediaViews, type MediaLibraryShape, type MediaViewsShape } from './contract.js';

/**
 * Media's views, over the Media page's files: the `MediaViews` tag's
 * implementation, which the media layer provides. The pages read it through the
 * tag (`live/views/media.ts`, its old copy, was deleted).
 */
export function mediaViews(media: Pick<MediaLibraryShape, 'list'>): MediaViewsShape {
    return MediaViews.of({
        // `GET /api/media`: a folder of the user's own files (never anyone
        // else's), newest first, with the folder tree, their usage and limits.
        mediaView: (userId, query) => media.list(userId, query),
    });
}
