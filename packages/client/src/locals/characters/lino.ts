import svg from '../art/lino.svg?raw';
import type { CharacterRig, Pose } from '../rig';

/**
 * Lino, the rooster: a Miami-native Local. Static avatar for now (CB-272);
 * animation parity with the original four comes later. The rig has only a
 * root part so the avatar renders at rest with no motion.
 */
export const lino: CharacterRig = {
    static: true,
    id: 'lino',
    name: 'Lino',
    svg,
    parts: {
        root: { pivot: [256, 256], stiffness: 320, damping: 26 },
    },
    motion(): Pose {
        return {};
    },
};
