// Manny's cut (rig-art.mjs), in the art's units (viewBox 0 0 512 512). Shape
// numbers are the flat SVG's shapes in order. He has no neck, so his head
// stays on the body and his face (eyes, brows, snout, whiskers) is a part of
// its own that nods over it. The fluke sits behind the body, its joint along
// the shirt's hem; both flippers sit in front, the near one on the belly and
// the far one, with the cafecito, against the body's side.
import { readFileSync } from 'node:fs';

// The source's shapes, for the raw patches below (rig-art.mjs reads the same).
const elements = [
    ...readFileSync(process.argv[3], 'utf8').matchAll(/^\s*(<(?:path|circle|ellipse|rect)\b[^>]*\/>)/gm),
].map((m) => m[1]);
const el = (i) => elements[i];
const recolor = (i, fill, extra = '') => el(i).replace(/fill="[^"]+"/, `fill="${fill}"${extra}`);
const bare = (i) => el(i).replace(/\sfill="[^"]+"/, '');

const d = (pts) => `M${pts.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join('L')}Z`;
// A region moved out (or, negative, in) by `by`, as rig-art.mjs grows one.
function offset(pts, by) {
    let area = 0;
    pts.forEach(([x, y], i) => {
        const [u, v] = pts[(i + 1) % pts.length];
        area += x * v - u * y;
    });
    const s = area > 0 ? 1 : -1;
    const normal = ([x0, y0], [x1, y1]) => {
        const l = Math.hypot(x1 - x0, y1 - y0) || 1;
        return [(s * (y1 - y0)) / l, (-s * (x1 - x0)) / l];
    };
    return pts.map((p, i) => {
        const n1 = normal(pts[(i - 1 + pts.length) % pts.length], p);
        const n2 = normal(p, pts[(i + 1) % pts.length]);
        const nx = n1[0] + n2[0];
        const ny = n1[1] + n2[1];
        const l = Math.hypot(nx, ny) || 1;
        return [p[0] + (nx / l) * by, p[1] + (ny / l) * by];
    });
}

// The seam between the fluke and the body, top to bottom: the outer edge of
// the body's outline, down past the shirt's corner and along its hem, to
// where the belly's outline starts. The body keeps every line on it.
const seam = [
    [114, 289],
    [116.6, 294],
    [117.2, 298],
    [117.8, 300],
    [119, 305],
    [121, 310],
    [122.8, 315],
    [123.3, 320],
    [123.8, 325],
    [124.6, 330],
    [125.3, 335],
    [125.8, 340],
    [128, 342.5],
    [130, 344.25],
    [132, 345.75],
    [134, 346.75],
    [136, 347.75],
    [138, 348.75],
    [138.5, 350],
    [139.75, 355],
    [141.25, 360],
    [143.25, 365],
    [145.5, 370],
    [148.25, 375],
    [151.25, 380],
    [154.75, 385],
    [158.5, 390],
    [163, 395],
    [168, 399],
    [172.5, 404],
    [174, 410],
    [173.5, 416],
    [172.4, 420],
    [173, 425],
    [175, 440],
    [178, 490],
];
const fluke = [[20, 289], ...seam, [20, 490]];
const along = (by) => offset(fluke, by).slice(1, seam.length + 1);
// The fluke's outline stops short of the body's, which is drawn once, by the
// body; its fill reaches well under the body, so lifting it shows no gap.
const flukeInk = offset(fluke, -0.5);
const flukeFill = offset(fluke, 7);

// The far flipper with the cup, against the body's side. Its edge there is
// the body's outline too, which both keep, so it can slide along it.
const cupFlipper = [
    [399.5, 245],
    [402, 241.2],
    [412, 240.8],
    [440, 240.8],
    [458, 241.5],
    [474, 247],
    [484.5, 261],
    [487.5, 285],
    [485.5, 305],
    [477.5, 323],
    [463.5, 337.5],
    [445, 343.5],
    [428, 342.6],
    [416, 341.6],
    [412, 339.5],
    [406.4, 334],
    [406.3, 325],
    [406.2, 320],
    [405.8, 315],
    [405.3, 310],
    [404.8, 305],
    [403.6, 300],
    [402.3, 295],
    [400.8, 290],
    [399.1, 285],
    [397.1, 280],
    [396.1, 275],
    [395.35, 270],
    [395.1, 265],
    [394.85, 258],
    [394.9, 255.5],
    [396, 253.6],
    [396.1, 252.5],
    [396.2, 251],
    [396.6, 249.5],
    [398, 248],
];
// Its copy of that line starts just inside the line's edge (the body's copy
// draws the edge, once), and its fills stop further in, off the shirt.
const inside = (by) => cupFlipper.map(([x, y]) => (y > 253 && y < 336 ? [x + by, y] : [x, y]));
const cupFlipperInk = inside(0.6);
const cupFlipperFill = inside(1.6);

// The near flipper on the belly, its outline and the hook at its shoulder.
const flipper = [
    [135.3, 337.8],
    [135.8, 333.5],
    [139.5, 328.8],
    [144.5, 323.6],
    [150, 318.6],
    [156, 314.6],
    [163, 311.2],
    [171, 307.8],
    [180, 305],
    [188, 302.8],
    [200, 301.2],
    [212, 300.6],
    [221, 301],
    [226.5, 302.2],
    [229.6, 304.2],
    [233.8, 306.5],
    [238, 311.5],
    [242, 316.5],
    [246, 322],
    [249.8, 327.5],
    [252.7, 333],
    [255.4, 338.6],
    [257.8, 344],
    [259.6, 349.5],
    [261.1, 355],
    [262.2, 360],
    [262.9, 365],
    [263.2, 370],
    [262.9, 375],
    [261.9, 380],
    [259.5, 385],
    [255.8, 390],
    [248.5, 394.6],
    [240, 397.6],
    [228, 399],
    [215, 398.6],
    [205, 395.9],
    [198, 392.7],
    [188.5, 388],
    [181, 383.2],
    [175, 378.5],
    [170, 374],
    [165.5, 369.2],
    [162, 364.4],
    [158.8, 359.6],
    [156, 354.6],
    [154.2, 351.2],
    [152.6, 347.4],
    [150, 344.5],
    [147, 342.2],
    [143, 341],
    [139.5, 340.6],
    [136.5, 340],
];

// The body: everything else, out to the tile's edge where nothing is drawn.
const body = [
    [30, 20],
    [500, 20],
    [500, 238.5],
    [412, 239.3],
    [401.5, 239.6],
    [399.5, 245],
    [398, 248],
    [396.6, 249.5],
    [396.2, 251],
    [396.1, 252.5],
    [396.1, 253.2],
    [397, 254.2],
    [398.4, 255.2],
    [398.1, 262],
    [398.4, 265],
    [398.9, 270],
    [399.6, 275],
    [400.9, 280],
    [403.3, 285],
    [404.5, 290],
    [406.5, 295],
    [407.8, 300],
    [408.1, 305],
    [409.1, 310],
    [409.8, 315],
    [410.3, 320],
    [410.6, 325],
    [410.9, 330],
    [411.1, 335],
    [411.1, 340],
    [412.6, 342.4],
    [416, 344.4],
    [428, 345.4],
    [445, 346.4],
    [465, 340.5],
    [488, 328],
    [500, 325],
    [500, 490],
];
// Its fills stop inside its outline, by the fluke and under the cup; its
// outline reaches a little past, so the line's edge is the body's alone.
const underCup = body.map(([x, y]) => (y > 254 && y < 342 && x > 390 && x < 420 ? [x - 0.7, y] : [x, y]));
const bodyFill = [...underCup, ...along(0.8).reverse(), [30, 289]];
const bodyLines = [...body, ...along(-1).reverse(), [30, 289]];
// Its outline stops under the near flipper's (a hole in its ink), so the
// flipper's own outline is the only one that moves.
const bodyInk =
    `<clipPath id="body-ink"><path clip-rule="evenodd" d="${d(bodyLines)}${d(offset(flipper, 0.5))}"/></clipPath>` +
    `<g clip-path="url(#body-ink)">${el(94)}</g>`;

// The far eye is nearly all pupil, with a sliver of white: the opening is
// the two together, a white eyeball under the pupil so it can look about,
// and a lid that comes down over both.
const farLid = '#8D9BB3';
const farLidTop = 114.9;
const lidEdge = ` stroke="${farLid}" stroke-width="0.8"`;
const farEye =
    // (The clip is a hair larger than the pupil, so it never trims its edge.)
    `<clipPath id="eye-far-ball">${bare(53).replace('/>', ' transform="matrix(1.04 0 0 1.04 -15.13 -5.22)"/>')}${bare(52)}</clipPath>` +
    recolor(53, '#F7EDDA', ' transform="matrix(0.96 0 0 0.96 15.1 5.2)"') +
    el(52) +
    `<g clip-path="url(#eye-far-ball)"><g data-rig="eye-far-pupil">${el(53)}${el(54)}${el(55)}</g></g>` +
    `<g data-rig="eye-far-lid" transform="matrix(1 0 0 0.001 0 ${(farLidTop * 0.999).toFixed(3)})">` +
    `${recolor(53, farLid, lidEdge)}${recolor(52, farLid, lidEdge)}</g>`;

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const cut = {
    shared: [2],
    ink: [94],
    drop: [52, 53, 54, 55],
    parts: [
        { name: 'tile', layers: [0] },
        { name: 'shadow', layers: [1] },
        { name: 'root', layers: [] },
        {
            name: 'fluke',
            base: flukeFill,
            ink: flukeInk,
            layers: ['base', 21, 22, 23, 24, 25, 'ink'],
        },
        {
            name: 'body',
            layers: [
                {
                    clip: bodyFill,
                    layers: [2, 3, 4, ...range(7, 20), 26, 27, ...range(37, 45), 49, 50],
                },
                bodyInk,
                ...range(113, 145),
                150,
            ],
        },
        {
            name: 'flipper',
            base: flipper,
            ink: offset(flipper, 0.8),
            layers: [46, 47, 48, 'ink'],
        },
        {
            name: 'face',
            layers: [
                5,
                6,
                51,
                farEye,
                56,
                57,
                58,
                {
                    eye: {
                        name: 'eye-near',
                        white: 59,
                        pupil: [60, 61, 62],
                        lid: '#7A89A2',
                        lidPivot: [264.5, 134.8],
                    },
                },
                { part: { name: 'eye-near-lash', layers: [108] } },
                ...range(63, 91),
                { part: { name: 'brow-far', layers: [92] } },
                { part: { name: 'brow-near', layers: [93] } },
                ...range(95, 107),
                109,
                110,
                { part: { name: 'eye-far-lash', layers: [111] } },
                112,
            ],
        },
        {
            name: 'cup-flipper',
            base: cupFlipperFill,
            ink: cupFlipperInk,
            layers: ['base', ...range(28, 36), 'ink', 146, 147, 148, 149],
        },
    ],
};
