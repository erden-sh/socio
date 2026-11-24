import svg from '../art/sebas.svg?raw';
import { enter, pulse, wave, type CharacterRig, type Pose } from '../rig';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One cycle of a state: 0..1 across `period` seconds. */
const cycle = (t: number, period: number) => (t % period) / period;

/** 0 below `a`, 1 above `b`, smooth between. */
const smooth = (a: number, b: number, x: number) => {
    const u = clamp((x - a) / (b - a), 0, 1);
    return u * u * (3 - 2 * u);
};

/**
 * His lids and shut-eye arches are drawn flat in the art (1/10000 tall) and
 * opened out by sy: 1 is the art (open, no arch), FLAT is full size.
 */
const FLAT = 10000;
// (Their springs are overdamped: an undershoot past 1 would flip them.)
const unflatten = (k: number) => 1 + (FLAT - 1) * k;

/**
 * Sebas (Sebastián), the Florida stone crab: confident, busy, a little
 * cheeky. He snips his raised claw at rest, clacks his claws like he's
 * typing when he works, drums his legs and shakes when he's kept waiting,
 * waves high and hops when he needs you, and pumps his claw, eyes shut and
 * grinning, when he's done. The gold chain rides along a beat behind.
 */
export const sebas: CharacterRig = {
    id: 'sebas',
    name: 'Sebas',
    svg,
    parts: {
        root: { pivot: [255, 446], stiffness: 320, damping: 26 },
        shadow: { pivot: [250, 428], stiffness: 320, damping: 26 },
        body: { pivot: [262, 400], parent: 'root', stiffness: 170, damping: 19 },
        // The face and chain ride the body; the face has no motion of its own.
        face: { pivot: [262, 400], parent: 'body' },
        'arm-r': { pivot: [372, 262], parent: 'body', stiffness: 150, damping: 15 },
        'hand-r': {
            pivot: [407, 273],
            parent: 'arm-r',
            nested: true,
            stiffness: 210,
            damping: 15,
        },
        'finger-r': {
            pivot: [482, 240],
            parent: 'hand-r',
            nested: true,
            stiffness: 520,
            damping: 26,
        },
        'leg-r1': {
            pivot: [332, 349],
            parent: 'body',
            stiffness: 420,
            damping: 24,
        },
        'leg-r2': {
            pivot: [378, 355],
            parent: 'body',
            stiffness: 420,
            damping: 24,
        },
        'leg-r3': {
            pivot: [406, 338],
            parent: 'body',
            stiffness: 420,
            damping: 24,
        },
        'leg-l1': { pivot: [70, 362], parent: 'body', stiffness: 420, damping: 24 },
        'leg-l2': {
            pivot: [108, 412],
            parent: 'body',
            stiffness: 420,
            damping: 24,
        },
        // The big claw rocks about its palm's middle, so its edges barely travel.
        'claw-l': {
            pivot: [135, 335],
            parent: 'body',
            stiffness: 170,
            damping: 16,
        },
        'pincer-l': {
            pivot: [176, 392],
            parent: 'claw-l',
            nested: true,
            stiffness: 520,
            damping: 26,
        },
        chain: { pivot: [275, 262], parent: 'body', stiffness: 70, damping: 8 },
        medallion: {
            pivot: [291.3, 309],
            parent: 'chain',
            nested: true,
            stiffness: 45,
            damping: 4.5,
        },
        'eye-l-pupil': {
            pivot: [221.5, 189.3],
            parent: 'face',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-r-pupil': {
            pivot: [358.6, 171.7],
            parent: 'face',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-l-shut': {
            pivot: [227, 154.93],
            parent: 'face',
            nested: true,
            stiffness: 3000,
            damping: 160,
        },
        'eye-r-shut': {
            pivot: [366.6, 140.3],
            parent: 'face',
            nested: true,
            stiffness: 3000,
            damping: 160,
        },
        'eye-l-arch': {
            pivot: [227, 201],
            parent: 'face',
            nested: true,
            stiffness: 3000,
            damping: 160,
        },
        'eye-r-arch': {
            pivot: [365.5, 183],
            parent: 'face',
            nested: true,
            stiffness: 3000,
            damping: 160,
        },
    },
    gaze: {
        // Down at the keys.
        working: [
            { at: [0.3, 0.85], hold: 1.3 },
            { at: [-0.2, 0.9], hold: 1 },
        ],
        // In step with the motion's 3.4 s cycle: left, right, then at you.
        waiting: [
            { at: [-1, 0.1], hold: 0.8 },
            { at: [1, 0.1], hold: 0.8 },
            { at: [0, 0], hold: 1.8 },
        ],
        needs: [{ at: [0.1, -0.15], hold: 4 }],
        done: [{ at: [0, 0], hold: 4 }],
    },
    motion({ state, t, since, gaze, blink, noise, current }) {
        const breathe = wave(t, 3.4);
        let rootTy = 0;
        let rootSx = 1;
        let rootSy = 1;
        let bodyR = noise(1, 0.3) * 0.8;
        let bodySy = 1 + breathe * 0.012;
        let bodyTy = 0;
        let armR = noise(2, 0.35) * 2;
        let handR = noise(3, 0.4) * 2;
        let finger = 0; // 0 shut .. 1 open
        let clawR = noise(4, 0.3) * 0.6;
        let pincer = 0;
        let swing = 0; // the medallion's own swing, on top of hanging plumb
        const legs = [0, 0, 0, 0, 0];
        // How far each state lowers his lids, and his shut eyes' arch (∩ +, ∪ −).
        let lids = 0;
        let arch = 0.35;

        switch (state) {
            case 'idle': {
                // Now and then a cheeky snip-snip and a tilt of the raised claw.
                const flex = pulse(t, 6.8, 1.1, 2.5);
                handR -= 9 * flex;
                armR -= 4 * flex;
                finger = Math.max(pulse(t, 6.8, 0.35, 2.7), pulse(t, 6.8, 0.35, 3.15));
                // ...and a single clack of the big claw, less often.
                pincer = pulse(t, 9.3, 0.4, 6);
                break;
            }
            case 'working': {
                // Clacking like typing: the big claw and the raised claw take turns.
                const a = pulse(t, 0.6, 0.26) * (0.8 + 0.2 * noise(5, 1.4));
                const b = pulse(t, 0.6, 0.26, 0.3) * (0.8 + 0.2 * noise(6, 1.6));
                pincer = a;
                clawR -= 1.8 * a;
                finger = b;
                armR += 3 * b - 3.5;
                handR -= 3 * b;
                bodyR += 0.6 * wave(t, 1.2);
                bodyTy += 0.8;
                break;
            }
            case 'waiting': {
                const c = cycle(since, 3.4) * 3.4;
                lids = 0.22;
                // A drum along the legs while he looks about...
                for (let i = 0; i < 3; i++) {
                    legs[i] = -4 * pulse(c, 0.36, 0.18, 0.12 * i);
                }
                legs[3] = -3 * pulse(c, 0.72, 0.18, 0.2);
                // ...a tap of the finger on the beat...
                finger = 0.5 * pulse(c, 0.72, 0.16, 0.5);
                armR -= 3;
                // ...and an impatient shake at the end.
                if (c > 2.75 && c < 3.35) {
                    const env = Math.sin(((c - 2.75) / 0.6) * Math.PI);
                    bodyR += 2.2 * Math.sin((c - 2.75) * Math.PI * 2 * 5) * env;
                }
                bodySy += 0.015 * pulse(c, 3.4, 0.8, 1.5);
                break;
            }
            case 'needs': {
                const c = cycle(since, 1.6) * 1.6;
                if (c < 0.18) {
                    const k = Math.sin((c / 0.18) * (Math.PI / 2));
                    rootSy = 1 - 0.06 * k;
                    rootSx = 1 + 0.03 * k;
                } else if (c < 0.56) {
                    const u = Math.sin(((c - 0.18) / 0.38) * Math.PI);
                    rootTy = -16 * u;
                    rootSy = 1 + 0.045 * u;
                    rootSx = 1 - 0.022 * u;
                } else if (c < 0.74) {
                    const k = Math.sin(((c - 0.56) / 0.18) * Math.PI);
                    rootSy = 1 - 0.07 * k;
                    rootSx = 1 + 0.035 * k;
                }
                // The raised claw high, waving.
                const up = enter(since, 0.4);
                armR = -20 * up + 2 * wave(t, 0.84);
                handR = (-6 + 11 * wave(t, 0.42)) * up;
                finger = 0.5 + 0.5 * wave(t, 0.42, 0.25);
                clawR -= 1.5;
                // The chain swings with the hops.
                swing = 6 * wave(since, 1.6, 0.1) * up;
                break;
            }
            case 'done': {
                const c = cycle(since, 2.4) * 2.4;
                lids = 1;
                arch = 1;
                // A little bounce, and a claw pump on it.
                if (c < 0.42) {
                    rootTy = -9 * Math.sin((c / 0.42) * Math.PI);
                }
                const pump = pulse(c, 2.4, 0.7, 0.05);
                armR = -16 * pump - 3;
                handR = -8 * pump;
                finger = pulse(c, 2.4, 0.3, 0.55) + pulse(c, 2.4, 0.3, 0.9);
                pincer = pulse(c, 2.4, 0.35, 0.6);
                clawR -= 1.2 * pump;
                swing = 4 * wave(since, 1.2, 0.15);
                break;
            }
            case 'paused': {
                lids = 1;
                arch = -0.7;
                // Asleep, sunk a little, claws lowered.
                bodySy = 0.985 + wave(t, 5) * 0.016;
                bodyR = 0.5;
                // (Lowered, the hand curls in: tipped out it would leave the tile.)
                armR = 5 + wave(t, 5, 0.1) * 0.8;
                handR = -9;
                clawR = 1.2;
                break;
            }
        }

        const lid = Math.max(blink, lids);
        const air = clamp(-rootTy / 16, 0, 1);
        // The chain lags the body; the medallion hangs plumb, so it swings when
        // he tips or hops.
        const bodyNow = current('body', 'r');
        const lift = current('root', 'ty') - rootTy;
        const pose: Pose = {
            root: { ty: rootTy, sx: rootSx, sy: rootSy },
            shadow: { sx: 1 - 0.3 * air, sy: 1 - 0.3 * air },
            body: { r: bodyR, ty: bodyTy, sy: bodySy, sx: 1 - (bodySy - 1) * 0.5 },
            chain: { r: -0.5 * bodyNow, ty: clamp(lift * 0.12, -2, 2) },
            medallion: {
                r: clamp(swing - 1.3 * bodyNow + lift * 0.25, -8, 8),
                ty: clamp(lift * 0.05, -1, 1),
            },
            'arm-r': { r: armR },
            'hand-r': { r: handR },
            'finger-r': { r: 13 * finger },
            'claw-l': { r: clawR },
            'pincer-l': { r: 9 * pincer },
            'leg-r1': { r: legs[0] },
            'leg-r2': { r: legs[1] },
            'leg-r3': { r: legs[2] * 0.8 },
            'leg-l1': { r: legs[3] },
            'leg-l2': { r: legs[3] * 0.6 },
            'eye-l-pupil': {
                tx: clamp(gaze[0], -1, 1) * 5,
                ty: clamp(gaze[1], -0.6, 1) * 4,
            },
            'eye-r-pupil': {
                tx: clamp(gaze[0], -1, 1) * 4,
                ty: clamp(gaze[1], -0.6, 1) * 4.5,
            },
            'eye-l-shut': { sy: unflatten(lid) },
            'eye-r-shut': { sy: unflatten(lid) },
            'eye-l-arch': { sy: unflatten(smooth(0.55, 1, lid) * arch) },
            'eye-r-arch': { sy: unflatten(smooth(0.55, 1, lid) * arch) },
        };
        return pose;
    },
};
