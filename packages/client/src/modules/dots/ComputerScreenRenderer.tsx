import { ComputerScreen } from '../computers/ComputerScreen';
import type { ToolRenderProps } from '../types';

/** The browser tools of a Dot's computer: their latest call shows its screen. */
export const COMPUTER_BROWSER_TOOLS = [
    'navigate',
    'snapshot',
    'read',
    'screenshot',
    'click',
    'type',
    'key',
    'scroll',
].map((action) => `computer_${action}`);

/** The Dot's computer screen, under the steps of the turn that last used its browser. */
export function ComputerScreenRenderer({ dot, onComputer }: ToolRenderProps) {
    return <ComputerScreen dotId={dot.id} dotName={dot.name} onExpand={onComputer} />;
}
