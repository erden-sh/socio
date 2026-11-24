/**
 * The `Gateway` tag's value (gateway/contract.ts): what coding sessions and
 * the apps' extraction route call of the gateways, over one runtime's
 * sources. The model and Git gateways stay built on first use
 * (`modelGatewayOf`, `gitGatewayOf`), one per set of sources; the layer
 * provides it (`layer.ts`).
 */
import { codeAccess } from './code-users.js';
import type { GatewayShape } from './contract.js';
import { deliverExtractionFrom } from './extract.js';
import { gitGatewayOf } from './git.js';
import { modelGatewayOf } from './model.js';
import { openPullRequest } from './pulls.js';
import type { GatewaySources } from './sources.js';

export function gatewayService(sources: GatewaySources): GatewayShape {
    return {
        mayRunCode: (personId) => codeAccess(sources, personId),
        get git() {
            return gitGatewayOf(sources);
        },
        get model() {
            return modelGatewayOf(sources);
        },
        openSessionPullRequest: (input) => openPullRequest(sources, input),
        deliverExtraction: (input) => deliverExtractionFrom(sources, input),
    };
}
