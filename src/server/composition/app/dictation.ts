/**
 * Live dictation's relays (`Dictation`, `new DictationStreams()`), as a leaf;
 * every reader takes it from this tag. Placed in the graph
 * (`composition/index.ts`, in the leaf bridges), before voice's step, which
 * offers the same instance again. One per runtime: built when the layer is, not
 * when this module loads. It registers no listener, so the graph's order
 * doesn't change. The shutdown still closes the relays itself
 * (`composition/lifecycle/voice.ts`, `LeaderWork.stop`): no finalizer.
 */
import { Layer } from 'effect';

import { Dictation } from '../../voice/contract.js';
import { DictationStreams } from '../../voice/dictation-stream.js';

/** The step, as `composition/index.ts` places it. */
export const appDictationLayers = { step: Layer.sync(Dictation, () => new DictationStreams()) };
