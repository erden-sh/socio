/**
 * The media layers: they implement `contract.ts`'s `Media` and `MediaViews`
 * with one `MediaService`, built from the tags it reads, all media's own: the
 * data space slice (`MediaData`), the workspace reads (`MediaWorkspace`) and
 * `MediaConfig`. The composition root (`composition/media.ts`) provides the
 * first two from dataspace's `Data` and the workspace's slices. Only it and
 * tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Media, MediaConfig, MediaData, MediaViews, MediaWorkspace } from './contract.js';
import { MediaService, type MediaServiceOptions } from './service.js';
import { mediaViews } from './view.js';

/**
 * The service on the workspace's connection (`db`, migrated at boot). It
 * registers its two data space listeners as it is built (the conversation
 * reads and file deletes). `held`: the attachments
 * still on their way, which the clean-up of unsent ones keeps (CB-223).
 */
export const mediaService = (db: DatabaseSync, held?: MediaServiceOptions['held']) =>
    Effect.gen(function* () {
        const data = yield* MediaData;
        const { media: settings } = yield* MediaConfig;
        const workspace = yield* MediaWorkspace;
        return new MediaService(db, { data, settings, held, workspace });
    });

/** Media's tags over one service. */
export const mediaContext = (media: MediaService) =>
    Context.make(Media, media).pipe(Context.add(MediaViews, mediaViews(media)));

/** `Media` and `MediaViews`, over a service built once. */
export const MediaLive = (db: DatabaseSync, held?: MediaServiceOptions['held']) =>
    Layer.effectContext(Effect.map(mediaService(db, held), mediaContext));
