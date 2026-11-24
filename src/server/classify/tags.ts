/**
 * The seam and the access log its routes write to, by tag: what the
 * module's hooks and Learning's triage use. Moved from `layer.ts` so the
 * module reads it from the app's services (one per runtime, where it was
 * kept per platform): only entry files import a `layer.ts`, and
 * `contract.ts` can't name the class. `layer.ts` builds it.
 */
import { Context } from 'effect';

import type { ClassifyParts } from './service.js';

export class ClassifyHost extends Context.Service<ClassifyHost, ClassifyParts>()('socio/classify/ClassifyHost') {}
