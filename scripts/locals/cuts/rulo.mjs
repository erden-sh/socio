// Rulo's cut (rig-art.mjs), in the art's units (viewBox 0 0 512 512). Shape
// numbers are the flat SVG's shapes in order. The art has one base fill (14)
// under the tail, body and near legs, and long outlines that run across
// joints (35 the throat and chest, 37 the tail, 70 the curl, 72 the crest):
// each is cut along the joint, every piece in its own part.
//
// The joints: the tail comes off the hip behind the crest, and its curled
// end (tail-tip) at the middle of the tail's rising side; the head at the
// throat, where the outline 35 bends, so a nod never breaks it; the legs at
// the shoulders and the hip, under the body's fill.

import { readFileSync } from 'node:fs';

// The flat art's shapes, for the patches below that rig-art can't build.
const shapes = [
    ...readFileSync(process.argv[3], 'utf8').matchAll(/^\s*(<(?:path|circle|ellipse|rect)\b[^>]*\/>)/gm),
].map((m) => m[1]);
const recolor = (i, fill) => shapes[i].replace(/fill="[^"]+"/, `fill="${fill}" stroke="${fill}" stroke-width="0.7"`);

// The far eye's iris pokes past its white on the left, so the iris moves
// inside the white and its own place at rest, and the lid closes over both.
const farEye =
    '<clipPath id="eye-far-socket">' +
    [89, 91].map((i) => shapes[i].replace(/\sfill="[^"]+"/, '')).join('') +
    '</clipPath>' +
    shapes[89] +
    '<g clip-path="url(#eye-far-socket)">' +
    `<g data-rig="eye-far-pupil">${[91, 92, 93].map((i) => shapes[i]).join('')}</g>` +
    '</g>' +
    '<g data-rig="eye-far-lid" transform="matrix(1 0 0 0.001 0 139.86)">' +
    [89, 91].map((i) => recolor(i, '#F4EBD4')).join('') +
    '</g>';

// A shut eye's line, a dark brush stroke: a happy arch (∩) as drawn, a
// sleepy curve (∪) flipped. It waits folded to nothing about its middle.
const shut = (name, [x, y], w, turn = 0) => {
    const h = w / 2;
    const d = `M${x - h} ${y + 6}Q${x} ${y - 8} ${x + h} ${y + 6}` + `Q${x} ${y - 3} ${x - h} ${y + 6}Z`;
    const k = 0.001;
    return (
        `<g data-rig="${name}" transform="matrix(${k} 0 0 ${k} ${+(x * (1 - k)).toFixed(3)} ${+(y * (1 - k)).toFixed(3)})">` +
        `<path d="${d}" fill="#49220A" stroke="#49220A" stroke-width="1.2" stroke-linejoin="round"${turn ? ` transform="rotate(${turn} ${x} ${y})"` : ''}/>` +
        '</g>'
    );
};

// The tail, from the hip to the middle of its rising side.
const tail = [
    [30, 248],
    [40, 248],
    [80, 246.5],
    [112, 245],
    [118, 243],
    [121, 249],
    [124, 253],
    [128, 257],
    [132, 261],
    [140, 262],
    [148, 280],
    [158, 300],
    [160, 312],
    [154, 317],
    [149, 321],
    [146, 326],
    [142, 331],
    [139, 336],
    [136, 341],
    [134, 347],
    [131, 349],
    [115, 352],
    [30, 352],
];
// The curled end: the rest of the tail, down to the gap above the crest.
const tip = [
    [30, 120],
    [215, 120],
    [215, 258],
    [165, 259.5],
    [140, 260],
    [132, 261],
    [128, 257],
    [124, 253],
    [121, 249],
    [118, 243],
    [112, 245],
    [80, 246.5],
    [40, 248],
    [30, 248],
];
// The trunk: from the tail's cut, under the hind thigh, along the belly line,
// under the front leg, round the chest and up under the head.
const body = [
    [140, 262],
    [165, 261],
    [185, 260],
    [203, 259],
    [212, 256],
    [214, 250],
    [255, 250],
    [258, 240],
    [440, 240],
    [440, 330],
    [380, 400],
    [300, 385],
    [262, 384],
    [251, 383.5],
    [245, 382.5],
    [239, 381.5],
    [233, 380.5],
    [227, 379.5],
    [221, 377.8],
    [215, 375.8],
    [210, 373.8],
    [204, 371.5],
    [198, 369],
    [195, 362],
    [182, 352],
    [170, 340],
    [163, 325],
    [160, 312],
    [158, 300],
    [148, 280],
];
// The body's own fill stops a little short of the tail's cut, so its edge
// always lies under the body's details, never over the tail's.
const bodyFill = body.map(([x, y]) => (x <= 163 && y >= 262 && y <= 325 ? [x + 1.2, y] : [x, y]));
// The hind thigh and foot, along its outline (40, 41) where the tail and the
// body meet it.
const thigh = [
    [154, 317],
    [165, 315],
    [180, 312],
    [194, 310],
    [200, 312],
    [204, 316],
    [207, 321],
    [210, 327],
    [211, 332],
    [211, 338],
    [209, 344],
    [207, 350],
    [204, 355],
    [201, 360],
    [197, 364],
    [205, 372],
    [225, 385],
    [215, 410],
    [175, 450],
    [80, 450],
    [80, 400],
    [95, 372],
    [115, 357],
    [131, 349],
    [134, 347],
    [136, 341],
    [139, 336],
    [142, 331],
    [146, 326],
    [149, 321],
];
// The near front leg, along its outlines (30, 44, 31, 33); its top, at the
// shoulder, blends into the chest.
const arm = [
    [293, 311],
    [300, 313],
    [305, 306],
    [313, 304],
    [314.5, 312],
    [316, 320],
    [317, 331],
    [316, 335],
    [314, 339],
    [313, 342],
    [311, 346],
    [309, 349],
    [307, 353],
    [306, 357],
    [304, 360],
    [302, 364],
    [300, 368],
    [301, 371],
    [302, 375],
    [302, 379],
    [303, 383],
    [304, 387],
    [304, 391],
    [305, 395],
    [306, 399],
    [306, 403],
    [307, 407],
    [307, 411],
    [308, 414],
    [325, 418],
    [345, 428],
    [345, 460],
    [245, 460],
    [240, 430],
    [240, 384],
    [249, 382],
    [251, 380],
    [251, 376],
    [251, 372],
    [254, 360],
    [262, 348],
    [264, 344],
    [266, 341],
    [268, 338],
    [271, 334],
    [273, 331],
    [276, 328],
    [278, 325],
    [281, 322],
    [284, 319],
    [287, 316],
    [290, 314],
];
// The throat outline (35) comes apart where it bends under the jaw, at the
// head's joint.
const aboveThroat = [
    [300, 40],
    [500, 40],
    [500, 289],
    [300, 257],
];
// The base fill shows a sliver along the snout, above the body's reach.
const aboveNeck = [
    [300, 40],
    [500, 40],
    [500, 240],
    [300, 240],
];
const jaw = [
    [296, 262],
    [345, 262],
    [345, 281],
    [296, 281],
];
const belowThroat = [
    [250, 257],
    [300, 257],
    [500, 289],
    [500, 450],
    [250, 450],
];

// The snout was never filled in the art: its outline (35) is an open
// stroke, and the tile's cream showed through it. Closed behind the face,
// in the tile's color, it looks as it did on the tile and stays opaque on
// any card.
const snout =
    '<path d="m302.1 379.8c27.75-4.189 56.9-23.91 70.17-51.84 7.331-14.25 12.33-32.99 16.29-47.53 3.084-12.04 6.4-22.92 10.76-26.88 29.21-16.81 56.79-46.89 56.67-64 0.1164-8.611-10.94-19.96-17.86-27.11L440 163 433.5 150.5 423 137.5 412 126.5 330 126 300 150 262 262Z" fill="#F4EBD4"/>';
// And a hairline under the chin, where the face's fill stops short of the
// jaw: a patch of the face's tan behind both.
const chin = '<path d="M286 262 287 252 292 245 300 243 304 246 296 252 292 262Z" fill="#E2B565"/>';

export const cut = {
    // Placed by hand, in the far eye's patch.
    drop: [89, 91, 92, 93],
    parts: [
        { name: 'tile', layers: [0] },
        { name: 'shadow', layers: [1] },
        { name: 'root', layers: [] },
        { name: 'leg-far-back', layers: [2, 42, 43] },
        { name: 'leg-far-front', layers: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
        {
            name: 'tail',
            layers: [
                { clip: tail, grow: 3, layers: [14] },
                20,
                21,
                { clip: tail, grow: 3, layers: [22, 37, 46, 47, 48] },
                49,
                { clip: tail, grow: 3, layers: [50] },
                54,
                { clip: tail, grow: 3, layers: [60, 70] },
                71,
                { clip: tail, grow: 1, layers: [72] },
                { clip: tail, grow: 3, layers: [148] },
                149,
                150,
                162,
                163,
                164,
                165,
                166,
                167,
            ],
        },
        {
            name: 'tail-tip',
            layers: [
                // Its fill reaches less far under the tail than its details do, so
                // the fill's edge is always covered.
                { clip: tip, grow: 0.5, layers: [14] },
                { clip: tip, grow: 0.8, layers: [37] },
                { clip: tip, grow: 1.5, layers: [50] },
                51,
                52,
                53,
                { clip: tip, grow: 1.5, layers: [54] },
                55,
                56,
                57,
                58,
                59,
                { clip: tip, grow: 1.5, layers: [60] },
                61,
                62,
                63,
                64,
                65,
                66,
                67,
                68,
                69,
                { clip: tip, grow: 1.6, layers: [70] },
            ],
        },
        {
            name: 'body',
            base: body,
            layers: [
                { clip: bodyFill, layers: [14] },
                16,
                17,
                18,
                19,
                22,
                23,
                34,
                { clip: belowThroat, layers: [35] },
                45,
                46,
                47,
                48,
                72,
                143,
                144,
                145,
                146,
                147,
                148,
                154,
                168,
                169,
                170,
                171,
                172,
                173,
                174,
                175,
                176,
                177,
                178,
                179,
                180,
                181,
                182,
                183,
                184,
            ],
        },
        {
            name: 'leg-near-back',
            layers: [
                { clip: thigh, layers: [14] },
                { clip: thigh, grow: 1, layers: [22] },
                24,
                38,
                39,
                40,
                41,
                151,
                152,
                153,
                // A highlight drawn over the thigh's outline.
                155,
            ],
        },
        {
            name: 'leg-near-front',
            layers: [
                { clip: arm, layers: [14] },
                13,
                25,
                26,
                27,
                28,
                29,
                30,
                31,
                32,
                33,
                44,
                156,
                157,
                158,
                159,
                160,
                161,
                // The far foot's toe line ends over this leg's outline.
                {
                    clip: [
                        [244, 390],
                        [256, 390],
                        [256, 402],
                        [244, 402],
                    ],
                    layers: [43],
                },
            ],
        },
        {
            name: 'head',
            layers: [
                { clip: aboveThroat, layers: [snout] },
                chin,
                { clip: aboveNeck, layers: [14] },
                15,
                { clip: aboveThroat, layers: [35] },
                36,
                73,
                74,
                75,
                76,
                77,
                78,
                79,
                80,
                81,
                82,
                83,
                84,
                85,
                86,
                87,
                88,
                farEye,
                { part: { name: 'eye-far-lash', layers: [90] } },
                shut('eye-far-shut', [416, 170], 26, -11.4),
                { part: { name: 'brow-far', layers: [94] } },
                95,
                96,
                97,
                {
                    eye: {
                        name: 'eye-near',
                        white: 98,
                        pupil: [99, 100, 101],
                        lid: '#E2B565',
                        lidPivot: [312.7, 166.6],
                    },
                },
                { part: { name: 'eye-near-lash', layers: [102] } },
                shut('eye-near-shut', [312.7, 206], 56),
                {
                    part: {
                        name: 'cap',
                        layers: [
                            103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
                            121, 122, 123, 124, 125, 134, 135,
                        ],
                    },
                },
                { part: { name: 'brow-near', layers: [126, 127] } },
                128,
                129,
                130,
                131,
                132,
                133,
                136,
                137,
                138,
                // The chest's shade lies over the jaw line's end.
                { clip: jaw, layers: [144] },
                { part: { name: 'hoop', layers: [139, 140, 141] } },
                142,
            ],
        },
    ],
};
