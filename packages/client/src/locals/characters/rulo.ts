import svg from '../art/rulo.svg?raw';
import { enter, pulse, wave, type Channels, type CharacterRig, type Pose, type Vec } from '../rig';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** One cycle of a state: 0..`period` seconds. */
const at = (t: number, period: number) => t % period;

/** A smooth 0..1..0 bump from `start` over `length` seconds of a cycle. */
const bump = (c: number, start: number, length: number) =>
    c > start && c < start + length ? Math.sin(((c - start) / length) * Math.PI) : 0;

// The joints the planted feet hang from.
const HIP: Vec = [175, 345];
const NEAR_SHOULDER: Vec = [298, 318];
const NEAR_FOOT: Vec = [293, 447];
const FAR_SHOULDER: Vec = [375, 322];
const FAR_FOOT: Vec = [418, 425];

/**
 * A front leg's channels that keep its foot where it is while the body
 * (turning `r` degrees about the hip, scaled `sx`, `sy`) carries its
 * shoulder: the leg turns back by as much as the body turns, and stretches
 * or folds to span the new height. `lift` raises the foot that far.
 */
function plant(shoulder: Vec, foot: Vec, { r, sx, sy }: { r: number; sx: number; sy: number }, lift = 0): Channels {
    const a = (r * Math.PI) / 180;
    const qx = (shoulder[0] - HIP[0]) * sx;
    const qy = (shoulder[1] - HIP[1]) * sy;
    const x = HIP[0] + Math.cos(a) * qx - Math.sin(a) * qy;
    const y = HIP[1] + Math.sin(a) * qx + Math.cos(a) * qy;
    const reach = foot[1] - shoulder[1];
    return {
        r: -r,
        tx: (shoulder[0] - x) / sx,
        sy: (foot[1] - y - lift) / sy / reach,
    };
}

/**
 * Rulo (Raúl), the curly-tailed lizard: a cocky little guy in a backwards
 * cap. He's never still: his eyes dart, he does push-ups to show off, and
 * his curled tail sways and lags behind him. He bobs his head and taps his
 * front feet like he's typing when he works, looks around and taps a foot
 * when he's kept waiting, does two big push-ups and a hop when he needs
 * you, squints happily when he's done, and sleeps with his head down.
 */
export const rulo: CharacterRig = {
    id: 'rulo',
    name: 'Rulo',
    svg,
    parts: {
        root: { pivot: [265, 440], stiffness: 320, damping: 26 },
        shadow: { pivot: [262, 425], stiffness: 320, damping: 26 },
        'leg-far-back': { pivot: [240, 400], parent: 'root' },
        'leg-near-back': { pivot: [160, 360], parent: 'root' },
        body: { pivot: HIP, parent: 'root', stiffness: 220, damping: 20 },
        'leg-far-front': {
            pivot: FAR_SHOULDER,
            parent: 'body',
            stiffness: 2500,
            damping: 100,
        },
        'leg-near-front': {
            pivot: NEAR_SHOULDER,
            parent: 'body',
            stiffness: 2500,
            damping: 100,
        },
        tail: { pivot: [150, 287], parent: 'body', stiffness: 70, damping: 9 },
        'tail-tip': {
            pivot: [88, 250],
            parent: 'tail',
            stiffness: 45,
            damping: 6,
        },
        head: { pivot: [391, 272], parent: 'body', stiffness: 240, damping: 18 },
        cap: {
            pivot: [360, 140],
            parent: 'head',
            nested: true,
            stiffness: 300,
            damping: 14,
        },
        hoop: {
            pivot: [271, 239],
            parent: 'head',
            nested: true,
            stiffness: 80,
            damping: 4.5,
        },
        'eye-near-pupil': {
            pivot: [308, 199],
            parent: 'head',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-far-pupil': {
            pivot: [414, 169.5],
            parent: 'head',
            nested: true,
            stiffness: 700,
            damping: 50,
        },
        'eye-near-lid': {
            pivot: [312.7, 166.6],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-far-lid': {
            pivot: [420, 140],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-near-lash': {
            pivot: [315.6, 178],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-far-lash': {
            pivot: [412, 150],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-near-shut': {
            pivot: [312.7, 206],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'eye-far-shut': {
            pivot: [416, 170],
            parent: 'head',
            nested: true,
            stiffness: 3000,
            damping: 110,
        },
        'brow-near': {
            pivot: [341, 150],
            parent: 'head',
            nested: true,
            stiffness: 400,
            damping: 30,
        },
        'brow-far': {
            pivot: [402, 147],
            parent: 'head',
            nested: true,
            stiffness: 400,
            damping: 30,
        },
    },
    gaze: {
        // Down at the keys, darting between them.
        working: [
            { at: [0.2, 0.85], hold: 1.2 },
            { at: [-0.2, 0.9], hold: 0.8 },
            { at: [0.45, 0.8], hold: 0.7 },
        ],
        // In step with the motion's 3.6 s cycle: left, right, then at you.
        waiting: [
            { at: [-1, 0], hold: 0.6 },
            { at: [1, -0.05], hold: 0.6 },
            { at: [0, 0], hold: 2.4 },
        ],
        needs: [{ at: [0.05, -0.15], hold: 4 }],
        done: [{ at: [0, 0], hold: 4 }],
    },
    motion({ state, t, since, gaze, blink, current, noise }) {
        const breathe = wave(t, 3.2);
        let rootTy = 0;
        let rootSx = 1;
        let rootSy = 1;
        let bodyR = noise(1, 0.3) * 0.3;
        let bodySy = 1 + breathe * 0.006;
        let headR = gaze[1] * 2.5 - gaze[0] * 0.8 + noise(2, 0.5) * 0.8;
        let tailR = wave(t, 4.6) * 1;
        let tipR = wave(t, 4.6, 0.12) * 1.6;
        let tipS = 1;
        let nearLift = 0;
        let farLift = 0;
        let brow = 0;
        let lids = 0;

        switch (state) {
            case 'idle': {
                // Every so often, a double push-up, just to show he can.
                const push = pulse(t, 9, 0.5, 2) + pulse(t, 9, 0.5, 2.6);
                bodyR -= 4 * push;
                headR -= 1.5 * push;
                break;
            }
            case 'working': {
                // Quick nods, and the front feet tapping in turn, like typing.
                headR += 4 * pulse(t, 0.42, 0.2) * (0.8 + 0.2 * noise(4, 1.7));
                nearLift = 5 * pulse(t, 0.42, 0.18, 0.21);
                farLift = 4 * pulse(t, 0.42, 0.18);
                bodyR += 0.6 * wave(t, 0.84);
                tipR = 1.2 * wave(t, 1.6);
                brow = 1.2;
                lids = 0.15;
                break;
            }
            case 'waiting': {
                const c = at(since, 3.6);
                // A flick of the tail, then a foot tapping while he stares at you.
                tipR += 3.5 * bump(c, 1.3, 0.35);
                tailR += 2 * bump(c, 1.25, 0.4);
                if (c > 2 && c < 3.4) {
                    nearLift = 4.5 * pulse(c, 0.35, 0.17, 2);
                }
                headR -= gaze[0] * 1.2;
                lids = 0.3;
                brow = 0.6;
                break;
            }
            case 'needs': {
                const c = at(since, 2.4);
                // Two big push-ups, then a hop.
                const push = bump(c, 0, 0.36) + bump(c, 0.44, 0.36);
                bodyR = -5.5 * push;
                headR = -3 - 1.5 * push;
                if (c > 0.85 && c < 1.0) {
                    const k = bump(c, 0.85, 0.3);
                    rootSy = 1 - 0.05 * k;
                    rootSx = 1 + 0.025 * k;
                } else if (c >= 1.0 && c < 1.4) {
                    const k = bump(c, 1.0, 0.4);
                    rootTy = -8 * k;
                    rootSy = 1 + 0.03 * k;
                    rootSx = 1 - 0.015 * k;
                } else if (c >= 1.4 && c < 1.55) {
                    const k = bump(c, 1.4, 0.15);
                    rootSy = 1 - 0.06 * k;
                    rootSx = 1 + 0.03 * k;
                }
                // The tail snaps tight.
                tailR = 1.8;
                tipR = 3;
                tipS = 0.97;
                brow = -4;
                lids = 0;
                break;
            }
            case 'done': {
                const c = at(since, 2.8);
                // The tail curls tight, then lets go; a proud little bob.
                tipR = 3 * (1 - enter(since, 1.6, 0.35)) + wave(t, 4.6, 0.12) * 1.2;
                tipS = 1 - 0.03 * (1 - enter(since, 1.6, 0.35));
                bodyR = -3 * bump(c, 0.1, 0.45);
                headR = -2.5 - bump(c, 0.1, 0.45);
                lids = 1;
                brow = -1.5;
                break;
            }
            case 'paused': {
                // Asleep: head down, tail loose, slow breaths.
                const slow = wave(t, 4.8);
                lids = 1;
                bodyR = 1.6;
                bodySy = 1 + slow * 0.01;
                headR = 4.5 + slow * 0.6;
                tailR = -1.2 + slow * 0.3;
                tipR = -2 + slow * 0.4;
                break;
            }
        }

        // The tail keeps more or less upright when the body tips, a beat late.
        tailR -= 0.6 * current('body', 'r');

        const lid = Math.max(blink, lids);
        // Open, a lid is folded away to nothing.
        const lidSx = lid > 0.003 ? 1 : 0.001;
        // As the lids meet, the shut line opens out: a happy arch (∩) when he's
        // done, a sleepy curve (∪) otherwise.
        const shut = Math.max(0.001, clamp((lid - 0.6) / 0.35, 0, 1));
        const shutSy = state === 'done' ? shut : -shut;
        // The crease above an eye rides the edge of a half-shut lid (an eye
        // `height` tall, the crease `inset` below its top), then settles `rest`
        // lower once the eye is shut.
        const crease = (height: number, inset: number, rest: number) => {
            const edge = Math.max(0, Math.min(lid, 0.55) * height - inset);
            return edge + (rest - edge) * shut;
        };
        const air = clamp(-rootTy / 8, 0, 1);
        const body = {
            r: current('body', 'r'),
            sx: current('body', 'sx'),
            sy: current('body', 'sy'),
        };
        // The earring hangs: it turns back as the head and body turn, and swings
        // when they move.
        const tilt = current('head', 'r') + current('body', 'r');
        const swing =
            (current('head', 'r') - headR) * 1.4 +
            (current('body', 'r') - bodyR) * 1.2 +
            (current('root', 'ty') - rootTy) * 0.6;
        const pose: Pose = {
            root: { ty: rootTy, sx: rootSx, sy: rootSy },
            shadow: { sx: 1 - 0.25 * air, sy: 1 - 0.25 * air },
            body: { r: bodyR, sy: bodySy, sx: 1 - (bodySy - 1) * 0.5 },
            'leg-near-front': plant(NEAR_SHOULDER, NEAR_FOOT, body, nearLift),
            'leg-far-front': plant(FAR_SHOULDER, FAR_FOOT, body, farLift),
            tail: { r: tailR },
            'tail-tip': { r: tipR, sx: tipS, sy: tipS },
            head: { r: headR },
            cap: { r: clamp((current('head', 'r') - headR) * 0.4, -1.5, 1.5) },
            hoop: { r: clamp(-tilt * 0.9 + swing, -16, 16) },
            'eye-near-pupil': {
                tx: gaze[0] >= 0 ? gaze[0] * 8 : gaze[0] * 4,
                ty: clamp(gaze[1], -1, 1) * (gaze[1] > 0 ? 5 : 3),
            },
            'eye-far-pupil': {
                tx: gaze[0] >= 0 ? gaze[0] * 6 : gaze[0] * 1.5,
                ty: clamp(gaze[1], -1, 1) * 4,
            },
            'eye-near-lid': { sx: lidSx, sy: Math.max(0.001, lid) },
            'eye-far-lid': { sx: lidSx, sy: Math.max(0.001, lid) },
            'eye-near-lash': { ty: crease(63, 12, 9) },
            'eye-far-lash': { ty: crease(55, 10, 7) },
            'eye-near-shut': { sx: shut, sy: shutSy },
            'eye-far-shut': { sx: shut, sy: shutSy },
            'brow-near': { ty: brow },
            'brow-far': { ty: brow * 0.6 },
        };
        return pose;
    },
};
