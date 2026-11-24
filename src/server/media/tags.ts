/**
 * Media's service, whole, by tag: what its module, routes and tools use
 * (other features use `Media`, the contract's slice). Moved from
 * `composition/media.ts` (`LegacyMedia`, which re-exports it), so the
 * module can read it from the app's services: `contract.ts` can't name the
 * class.
 */
import { Context } from 'effect';

import type { MediaService } from './service.js';

/** Chat attachments, under the graph's `MediaServiceTag` tag (the class). */
export class MediaServiceTag extends Context.Service<MediaServiceTag, MediaService>()('socio/media/MediaService') {}
