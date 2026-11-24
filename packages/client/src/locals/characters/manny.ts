import svg from '../art/manny.svg?raw';
import { enter, pulse, wave, type CharacterRig, type Pose } from '../rig';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One cycle of a state: 0..1 across `period` seconds. */
const cycle = (t: number, period: number) => (t % period) / period;

/** 0..1..0 with eased edges: up over `rise`, held, down over `fall`. */
function hold(t: number, start: number, rise: number, held: number, fall: number) {
    if (t < start || t > start + rise + held + fall) {
        return 0;
    }
    if (t < start + rise) {
        return enter(t, rise, start);
    }
    if (t < start + rise + held) {
        return 1;
    }
    return 1 - enter(t, fall, start + rise + held);
}

/**
 * Manny (Armando), the manatee: slow, patient, thorough, an abuelo with his
 * cafecito. He sways and breathes heavily at rest and takes a sip now and
 * then, taps his flipper like he's writing when he works, looks about and
 * taps his fluke with a sigh when he's kept waiting, bounces (carefully, the
 * cup) when he needs you, raises a little "salud" when he's done, and dozes
 * off when he's paused.
 */
export const manny: CharacterRig = {
    id: 'manny',
    name: 'Manny',
    svg,
    parts: {
        root: { pivot: [260, 452], stiffness: 110, damping: 17 },
        shadow: { pivot: [234, 448], stiffness: 110, damping: 17 },
        body: { pivot: [262, 450], parent: 'root', stiffness: 80, damping: 14 },
        // Its spring is near critical: the fluke lifts and settles, it never
        // swings forward of where it rests (that would bare its joint).
        fluke: { pivot: [168, 408], parent: 'body', stiffness: 150, damping: 24 },
        flipper: { pivot: [152, 347], parent: 'body', stiffness: 110, damping: 15 },
        'cup-flipper': {
            pivot: [412, 320],
            parent: 'body',
            stiffness: 70,
            damping: 15,
        },
        face: { pivot: [330, 215], parent: 'body', stiffness: 75, damping: 13 },
        'eye-near-pupil': {
            pivot: [264.5, 156],
            parent: 'face',
            nested: true,
            stiffness: 500,
            damping: 45,
        },
        'eye-far-pupil': {
            pivot: [378, 130],
            parent: 'face',
            nested: true,
            stiffness: 500,
            damping: 45,
        },
        'eye-near-lid': {
            pivot: [264.5, 134.8],
            parent: 'face',
            nested: true,
            stiffness: 2200,
            damping: 95,
        },
        'eye-far-lid': {
            pivot: [378, 114.9],
            parent: 'face',
            nested: true,
            stiffness: 2200,
            damping: 95,
        },
        'eye-near-lash': {
            pivot: [264, 140],
            parent: 'face',
            nested: true,
            stiffness: 2200,
            damping: 95,
        },
        'eye-far-lash': {
            pivot: [382, 120],
            parent: 'face',
            nested: true,
            stiffness: 2200,
            damping: 95,
        },
        'brow-near': {
            pivot: [256, 101],
            parent: 'face',
            nested: true,
            stiffness: 300,
            damping: 28,
        },
        'brow-far': {
            pivot: [370, 85],
            parent: 'face',
            nested: true,
            stiffness: 300,
            damping: 28,
        },
    },
    gaze: {
        // Down at the flipper he's writing with, now and then a line further on.
        working: [
            { at: [-0.45, 0.9], hold: 1.8 },
            { at: [-0.2, 0.95], hold: 1.4 },
        ],
        // In step with the motion's 6 s cycle: a slow look left, right, then at you.
        waiting: [
            { at: [-1, 0.05], hold: 1.4 },
            { at: [1, 0.05], hold: 1.4 },
            { at: [0, 0], hold: 3.2 },
        ],
        needs: [{ at: [0, -0.1], hold: 4 }],
        done: [{ at: [0, 0], hold: 4 }],
    },
    motion({ state, t, since, gaze, blink, noise }) {
        const breathe = wave(t, 4.8);
        let rootTy = 0;
        let rootR = noise(1, 0.12) * 0.5 + wave(t, 9) * 0.5;
        let rootSx = 1;
        let rootSy = 1;
        let bodySy = 1 + breathe * 0.012;
        let faceR = gaze[1] * 1.2 + noise(2, 0.18) * 0.6;
        let faceTx = gaze[0] * 1.8;
        let faceTy = gaze[1] * 1.2 + breathe * 0.4;
        let flipR = wave(t, 4.8, 0.2) * 1.2;
        let cupR = wave(t, 4.8, 0.1) * 0.8;
        let cupTx = 0;
        let cupTy = 0;
        let flukeR = (wave(t, 7.5) + 1) * 0.5;
        let brow = 0;
        // His lids are heavy by nature; how far each state lowers them.
        let lids = 0.1;

        switch (state) {
            case 'idle': {
                // Every 8 s or so, a sip of his cafecito: the cup comes up to the
                // snout as he leans into it, a moment to savour it, and down again.
                const sip = hold(since % 8.5, 5.2, 0.8, 1.1, 0.9);
                cupR -= 9 * sip;
                cupTx -= 2 * sip;
                cupTy -= 7 * sip;
                faceR += 2.6 * sip;
                faceTx += 1.6 * sip;
                faceTy += 1 * sip;
                rootR += 0.6 * sip;
                lids += 0.4 * hold(since % 8.5, 5.7, 0.4, 1.0, 0.6);
                break;
            }
            case 'working': {
                // Steady taps, like writing a line, and a nod every other one.
                const tap = pulse(t, 0.95, 0.4) * (0.8 + 0.2 * noise(4, 0.8));
                flipR = 2.5 * tap - 0.5;
                faceTy += 1.6 * pulse(t, 1.9, 0.7, 0.2);
                faceR += 1.2 * pulse(t, 1.9, 0.7, 0.2);
                rootR += 0.4 * wave(t, 3.8);
                lids = 0.3;
                brow = 1;
                break;
            }
            case 'waiting': {
                const c = cycle(since, 6) * 6;
                lids = 0.2;
                brow = -1.5;
                faceTx = gaze[0] * 2.6;
                // Three taps of the fluke while he looks at you, then a long sigh.
                if (c > 2.9 && c < 4.7) {
                    flukeR = 4.5 * pulse(c, 0.6, 0.4, 2.9);
                }
                const sigh = pulse(c, 6, 1.7, 4.2);
                bodySy += 0.03 * sigh;
                faceTy -= 1.2 * sigh;
                lids += 0.25 * pulse(c, 6, 1.2, 4.9);
                break;
            }
            case 'needs': {
                // A heavy hop: sink, up, and a squash when he lands.
                const c = cycle(since, 1.9) * 1.9;
                if (c < 0.25) {
                    const k = Math.sin((c / 0.25) * (Math.PI / 2));
                    rootSy = 1 - 0.05 * k;
                    rootSx = 1 + 0.025 * k;
                } else if (c < 0.85) {
                    const u = (c - 0.25) / 0.6;
                    rootTy = -13 * Math.sin(u * Math.PI);
                    rootSy = 1 + 0.03 * Math.sin(u * Math.PI);
                    rootSx = 1 - 0.015 * Math.sin(u * Math.PI);
                } else if (c < 1.15) {
                    const k = Math.sin(((c - 0.85) / 0.3) * Math.PI);
                    rootSy = 1 - 0.08 * k;
                    rootSx = 1 + 0.04 * k;
                }
                flipR = -12 + 6 * wave(t, 0.6);
                // The cup stays level: it rides the hop a beat late, never tips.
                cupR = -rootR - 1;
                cupTy = 2 * Math.sin((c / 1.9) * Math.PI * 2);
                faceR -= 1.5;
                brow = -2;
                lids = 0;
                break;
            }
            case 'done': {
                // A content squint, and the cup raised: ¡salud!
                const c = cycle(since, 3.6) * 3.6;
                const up = enter(since, 0.9, 0.2);
                lids = 1;
                brow = -0.5;
                faceR -= 1.5;
                cupTy = -11 * up - 2.5 * pulse(c, 3.6, 0.5, 1.2);
                cupR = 3 * up - 2 * pulse(c, 3.6, 0.5, 1.2);
                cupTx = 1.5 * up;
                rootTy = -2 * pulse(c, 3.6, 0.6, 1.1);
                break;
            }
            case 'paused': {
                // Dozing: his head sinks, his breath slows right down.
                const slow = wave(t, 7);
                lids = 1;
                bodySy = 1 + slow * 0.02;
                faceTy = 3 + slow * 0.8;
                faceR = 2.5 + slow * 0.6;
                faceTx = 0;
                rootR = 0.8 + slow * 0.3;
                flipR = 1;
                cupR = 2;
                cupTy = 1;
                flukeR = 0;
                break;
            }
        }

        const lid = Math.max(blink, lids);
        // Shut, the lash line is a content arch (∩) when he's done, a sleepy
        // curve (∪) when he's paused.
        const lashSy = state === 'paused' ? 1 - lid * 1.6 : 1 - lid * 0.45;
        const air = clamp(-rootTy / 13, 0, 1);
        const pose: Pose = {
            root: { ty: rootTy, r: rootR, sx: rootSx, sy: rootSy },
            shadow: { sx: 1 - 0.25 * air, sy: 1 - 0.25 * air },
            body: { sy: bodySy, sx: 1 - (bodySy - 1) * 0.5 },
            fluke: { r: Math.max(0, flukeR) },
            flipper: { r: flipR },
            'cup-flipper': { r: cupR, tx: cupTx, ty: cupTy },
            face: { r: faceR, tx: faceTx, ty: faceTy },
            'eye-near-pupil': {
                tx: gaze[0] * 3.2,
                ty: clamp(gaze[1], -0.5, 1) * 2.4,
            },
            'eye-far-pupil': {
                tx: gaze[0] * 2.2,
                ty: clamp(gaze[1], -0.5, 1) * 1.6,
            },
            'eye-near-lid': { sy: Math.max(0.001, lid) },
            'eye-far-lid': { sy: Math.max(0.001, lid) },
            'eye-near-lash': { ty: lid * (state === 'paused' ? 36 : 30), sy: lashSy },
            'eye-far-lash': { ty: lid * (state === 'paused' ? 19 : 17), sy: lashSy },
            'brow-near': { ty: brow },
            'brow-far': { ty: brow },
        };
        return pose;
    },
};
