import { ContinueConnect } from './ConnectAgent';

/** `/connect/continue`: back to the agent's request once signed in (CB-90). */
export default function ConnectContinueRoute() {
    return <ContinueConnect />;
}
