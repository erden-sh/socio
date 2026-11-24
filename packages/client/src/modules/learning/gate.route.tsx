import { MODULE_IDS } from '@socio/shared/modules';

import { gateHandle, gateMiddleware, ModuleGate } from '../gate';

export { ModuleErrorBoundary as ErrorBoundary } from '../gate';
export const handle = gateHandle(MODULE_IDS.learning);
export const middleware = [gateMiddleware(MODULE_IDS.learning)];
export default function Gate() {
    return <ModuleGate id={MODULE_IDS.learning} />;
}
