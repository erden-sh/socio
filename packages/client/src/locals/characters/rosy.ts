import svg from '../art/rosy.svg?raw';
import type { CharacterRig, Pose } from '../rig';

/**
 * Rosy, the roseate spoonbill: a Miami-native Local. Static avatar for now
 * (CB-272); animation parity with the original four comes later. The rig
 * has only a root part so the avatar renders at rest with no motion.
 */
export const rosy: CharacterRig = {
    static: true,
    id: 'rosy',
    name: 'Rosy',
    svg,
    parts: {
        root: { pivot: [256, 256], stiffness: 320, damping: 26 },
    },
    motion(): Pose {
        return {};
    },
};
