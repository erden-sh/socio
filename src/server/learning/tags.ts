/**
 * Learning's analysis, whole, by tag: what its module and routes use
 * (other features use `Learning`, the contract's slice). Moved from
 * `layer.ts` so the module can read it from the app's services: only entry
 * files import a `layer.ts`, and `contract.ts` can't name the class.
 * `layer.ts` builds it.
 */
import { Context } from 'effect';

import type { LearningAnalysis } from './analysis.js';

/**
 * The analysis, under the graph's `LearningJob` tag (the class), with every method
 * Learning's own module and routes call. Other features see the
 * `Learning` tag, typed by the contract.
 */
export class LearningJob extends Context.Service<LearningJob, LearningAnalysis>()('socio/learning/LearningAnalysis') {}
