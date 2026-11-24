import { MODULE_IDS } from '@socio/shared/modules';

import { gateHandle, gateMiddleware, ModuleGate } from '../gate';

export { ModuleErrorBoundary as ErrorBoundary } from '../gate';
export const handle = gateHandle(MODULE_IDS.plugins);
export const middleware = [gateMiddleware(MODULE_IDS.plugins)];
export default function Gate() {
    return <ModuleGate id={MODULE_IDS.plugins} />;
}
