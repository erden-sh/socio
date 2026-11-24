import svg from '../art/mingo.svg?raw';
import { pulse, wave, type CharacterRig, type Pose } from '../rig';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One cycle of a state: 0..1 across `period` seconds. */
const cycle = (t: number, period: number) => (t % period) / period;

/**
 * Mingo (Domingo), the flamingo: poised, a bit vain. She side-eyes at rest,
 * pecks at the keys when she works, taps her tucked foot and shakes her head
 * when she's kept waiting, hops and waves when she needs you, and squints
 * happily when she's done.
 */
export const mingo: CharacterRig = {
    id: 'mingo',
    name: 'Mingo',
    svg,
    parts: {
        root: { pivot: [41.5, 75.8], stiffness: 320, damping: 26 },
        shadow: { pivot: [44.8, 73.2], stiffness: 320, damping: 26 },
        'leg-standing': { pivot: [39, 75], parent: 'root' },
        body: { pivot: [39.2, 59.5], parent: 'root', stiffness: 170, damping: 19 },
        'leg-tucked': {
            pivot: [34.2, 57.7],
            parent: 'body',
            stiffness: 230,
            damping: 17,
        },
        wing: { pivot: [41.5, 40.5], parent: 'body', stiffness: 190, damping: 13 },
        head: { pivot: [45, 34.8], parent: 'body', stiffness: 140, damping: 16 },
        'eye-near-pupil': {
            pivot: [38.5, 25.1],
            parent: 'head',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-far-pupil': {
            pivot: [54.4, 20.6],
            parent: 'head',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-near-lid': {
            pivot: [40.2, 21.5],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-far-lid': {
            pivot: [55.7, 17.4],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-near-lash': {
            pivot: [39, 23.4],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'brow-near': {
            pivot: [39.3, 18.8],
            parent: 'head',
            nested: true,
            stiffness: 400,
            damping: 30,
        },
        'brow-far': {
            pivot: [54.1, 14.9],
            parent: 'head',
            nested: true,
            stiffness: 400,
            damping: 30,
        },
    },
    gaze: {
        working: [
            { at: [0.5, 0.8], hold: 1.4 },
            { at: [0.2, 0.9], hold: 0.9 },
        ],
        // In step with the motion's 3.4 s cycle: left, right, then a long look at you.
        waiting: [
            { at: [-1, 0.1], hold: 0.8 },
            { at: [1, 0.1], hold: 0.8 },
            { at: [0, 0], hold: 1.8 },
        ],
        needs: [{ at: [0.15, -0.2], hold: 4 }],
        done: [{ at: [0, 0], hold: 4 }],
    },
    motion({ state, t, since, gaze, blink, noise }) {
        const breathe = wave(t, 3.6);
        let rootTy = 0;
        let rootSx = 1;
        let rootSy = 1;
        let bodyR = noise(1, 0.3) * 1;
        let bodySy = 1 + breathe * 0.012;
        let headR = gaze[1] * 3 + noise(2, 0.4) * 1.5;
        let headTx = gaze[0] * 0.5;
        let headTy = 0;
        let wingR = wave(t, 3.6, 0.15) * 0.6;
        let tuckR = noise(3, 0.25) * 0.8;
        let brow = 0;
        // Her lids are heavy by nature; how far each state lowers them.
        let lids = 0.08;

        switch (state) {
            case 'idle': {
                // Now and then a little chin-up toss.
                headR -= 6 * pulse(t, 7.3, 0.9, 2);
                break;
            }
            case 'working': {
                const peck = pulse(t, 0.55, 0.22) * (0.75 + 0.25 * noise(4, 1.3));
                headR += 5 * peck;
                headTy += 0.5 * peck;
                wingR = -2.6 * pulse(t, 0.55, 0.18, 0.27);
                bodyR += 0.8 * wave(t, 1.1);
                brow = 0.3;
                break;
            }
            case 'waiting': {
                const c = cycle(since, 3.4) * 3.4;
                lids = 0.35;
                brow = -0.25;
                headTx = gaze[0] * 0.8;
                if (c > 1.6 && c < 2.8) {
                    tuckR = -7 * pulse(c, 0.4, 0.2, 1.6);
                }
                if (c > 2.8 && c < 3.35) {
                    const env = Math.sin(((c - 2.8) / 0.55) * Math.PI);
                    headR += 5 * Math.sin((c - 2.8) * Math.PI * 2 * 5) * env;
                }
                bodySy += 0.02 * pulse(c, 3.4, 0.8, 1.5);
                break;
            }
            case 'needs': {
                const c = cycle(since, 1.6) * 1.6;
                if (c < 0.18) {
                    const k = Math.sin((c / 0.18) * (Math.PI / 2));
                    rootSy = 1 - 0.06 * k;
                    rootSx = 1 + 0.03 * k;
                } else if (c < 0.56) {
                    const u = (c - 0.18) / 0.38;
                    rootTy = -3.5 * Math.sin(u * Math.PI);
                    rootSy = 1 + 0.05 * Math.sin(u * Math.PI);
                    rootSx = 1 - 0.025 * Math.sin(u * Math.PI);
                } else if (c < 0.72) {
                    const k = Math.sin(((c - 0.56) / 0.16) * Math.PI);
                    rootSy = 1 - 0.08 * k;
                    rootSx = 1 + 0.045 * k;
                }
                wingR = -11 + 6 * wave(t, 0.42);
                headR -= 4;
                brow = -0.8;
                lids = 0;
                break;
            }
            case 'done': {
                const c = cycle(since, 2.6) * 2.6;
                lids = 1;
                headR -= 5;
                if (c < 0.45) {
                    const u = c / 0.45;
                    rootTy = -2.5 * Math.sin(u * Math.PI);
                }
                tuckR = 14 * pulse(c, 2.6, 0.5, 0.1);
                wingR = -8 * pulse(c, 2.6, 0.6, 0.05);
                brow = -0.3;
                break;
            }
            case 'paused': {
                lids = 1;
                headR = 9 + breathe * 1;
                headTy = 0.5;
                bodySy = 1 + wave(t, 4.5) * 0.02;
                wingR = 1.5;
                break;
            }
        }

        const lid = Math.max(blink, lids);
        // Shut, the lash line is a happy arch (∩) when she's done, a sleepy
        // curve (∪) when she's paused.
        const lashSy = state === 'paused' ? 1 - lid * 1.5 : 1 - lid * 0.3;
        const air = clamp(-rootTy / 3.5, 0, 1);
        const pose: Pose = {
            root: { ty: rootTy, sx: rootSx, sy: rootSy },
            shadow: { sx: 1 - 0.28 * air, sy: 1 - 0.28 * air },
            body: { r: bodyR, sy: bodySy, sx: 1 - (bodySy - 1) * 0.5 },
            'leg-tucked': { r: tuckR },
            wing: { r: wingR },
            head: { r: headR, tx: headTx, ty: headTy },
            'eye-near-pupil': {
                tx: (gaze[0] + 1) * 1.5,
                ty: clamp(gaze[1], -0.4, 0.9),
            },
            'eye-far-pupil': {
                tx: (gaze[0] + 1) * 1.05,
                ty: clamp(gaze[1] * 0.9, -0.3, 0.8),
            },
            'eye-near-lid': { sy: Math.max(0.001, lid) },
            'eye-far-lid': { sy: Math.max(0.001, lid) },
            'eye-near-lash': { ty: lid * 4.6, sy: lashSy },
            'brow-near': { ty: brow },
            'brow-far': { ty: brow },
        };
        return pose;
    },
};
