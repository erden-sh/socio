import { Context, Effect, Layer } from 'effect';

import { Approvals } from '../approvals/contract.js';
/**
 * Chat attachments' construction: the media's step of the graph, which builds
 * the service through the media layer (`media/layer.ts`).
 */
import { steeringQueue } from '../context/steering.js';
import { Data } from '../dataspace/contract.js';
import { MediaConfig, MediaData, MediaWorkspace } from '../media/contract.js';
import { mediaContext, mediaService } from '../media/layer.js';
import { registerSpaceUploadApprovals } from '../media/space-upload.js';
import { MediaServiceTag } from '../media/tags.js';
import { Conversations, Socios, Spaces } from '../workspace/contract.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { AppWorkspace } from './workspace-parts.js';

/** What waits in a chat's queue is not left unsent (CB-223). */
const heldIn = (db: AppWorkspace['db']) => () => steeringQueue(db).attachmentIds();

/**
 * Media's ports over the folders above it (dependency inversion): the data
 * space (`Data`) as `MediaData`, and the workspace's `Socios`,
 * `Conversations` and `Spaces` slices as `MediaWorkspace`, each read at
 * the moment of use.
 */
const mediaPorts = (pages?: Pick<AppWorkspace['pages'], 'get' | 'embedsNamed'>) =>
    Effect.gen(function* () {
        const data = yield* Data;
        const spaces = yield* Spaces;
        const socios = yield* Socios;
        const conversations = yield* Conversations;
        return {
            data: MediaData.of(data),
            workspace: MediaWorkspace.of({
                dot: (id) => socios.dot(id),
                thread: (id) => conversations.thread(id),
                readableThread: (userId, id) => conversations.readableThread(userId, id),
                allows: (userId, id, action) => conversations.allows(userId, id, action),
                readsSpace: (userId, spaceId) => spaces.readsSpace(userId, spaceId),
                // Space uploads (CB-524): who may add to a Space's media, the
                // socio's own Space access, the page an upload is for, and which
                // uploads pages still name.
                spaceName: (spaceId) => spaces.spaces().find((space) => space.id === spaceId)?.name,
                editsSpace: (userId, spaceId) => spaces.editsSpace(userId, spaceId),
                socioReads: (threadId, spaceId, dotId) => conversations.socioReads(threadId, spaceId, dotId),
                ...(pages
                    ? {
                          livePage: (spaceId: string, pageId: string) => {
                              try {
                                  return pages.get(spaceId, pageId).spaceId === spaceId;
                              } catch {
                                  return false;
                              }
                          },
                          embedsNamed: (ids: readonly string[], options?: { revisions?: boolean }) =>
                              pages.embedsNamed(ids, options),
                      }
                    : {}),
            }),
        };
    });

/** The ports as a layer, over `Data` and the workspace's slices (tests). */
export const MediaPortsLive = Layer.effectContext(
    Effect.map(mediaPorts(), ({ data, workspace }) =>
        Context.make(MediaData, data).pipe(Context.add(MediaWorkspace, workspace)),
    ),
);

/** Chat attachments, under the graph's `LegacyMedia` tag (the class): media's own tag. */
export { MediaServiceTag as LegacyMedia };

/**
 * Media's step of the graph: the media layer's service, offered as `Media`
 * and `MediaViews`, with `MediaConfig` from the supplied startup
 * configuration (`PlatformConfig.media`, which the entry parses with
 * composition's environment readers), and as `LegacyMedia` for the steps that
 * still take the class.
 * Built at the same point of the chain as before, so its data space
 * listeners register in the same order.
 */
export const mediaLayers = {
    media: Layer.effectContext(
        Effect.gen(function* () {
            const workspace = yield* LegacyWorkspace;
            const config = MediaConfig.of({ media: (yield* LegacyConfig).media });
            const ports = yield* mediaPorts(workspace.pages);
            // A socio's uploads into a Space's media wait on the person (CB-524).
            registerSpaceUploadApprovals(yield* Approvals);
            const media = yield* mediaService(workspace.db, heldIn(workspace.db)).pipe(
                Effect.provideService(MediaConfig, config),
                Effect.provideService(MediaData, ports.data),
                Effect.provideService(MediaWorkspace, ports.workspace),
            );
            return mediaContext(media).pipe(Context.add(MediaServiceTag, media), Context.add(MediaConfig, config));
        }),
    ),
};
