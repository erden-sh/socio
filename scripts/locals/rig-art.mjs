// Turns a Local's flat Quiver SVG into rigged art (packages/client/src/locals/art):
// every part a <g data-rig="…"> with its own fills, and the shared ink and
// base fill cut along the part's region so a part can move without tearing
// its neighbor's outline. Eyes get pupils that move inside the white, a lid
// in skin color and a lash line that comes down with it.
//
//   node scripts/locals/rig-art.mjs <character> <flat.svg>
//
// A character's cut (which shapes go where, the regions, the joints' patches)
// is in scripts/locals/cuts/<character>.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , character, source] = process.argv;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { cut } = await import(`./cuts/${character}.mjs`);
const svg = readFileSync(source, 'utf8');

const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
const elements = [...svg.matchAll(/^\s*(<(?:path|circle|ellipse|rect)\b[^>]*\/>)/gm)].map((m) => m[1]);
const el = (i) => {
    if (!elements[i]) {
        throw new Error(`${character}: no shape ${i}`);
    }
    return elements[i];
};
const poly = (pts) => `M${pts.map(([x, y]) => `${+x.toFixed(3)} ${+y.toFixed(3)}`).join('L')}Z`;
// A region grown outward by d: a part behind its neighbors reaches a little
// under them, so the seam between two clips never shows the tile through.
function grow(pts, d) {
    if (!d) {
        return pts;
    }
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
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[(i + 1) % pts.length];
        const n1 = normal(a, p);
        const n2 = normal(p, b);
        const nx = n1[0] + n2[0];
        const ny = n1[1] + n2[1];
        const l = Math.hypot(nx, ny) || 1;
        const k = Math.min(2, 2 / (1 + n1[0] * n2[0] + n1[1] * n2[1] || 1));
        return [p[0] + (nx / l) * d * Math.sqrt(k), p[1] + (ny / l) * d * Math.sqrt(k)];
    });
}

// The source's own defs (gradients) come along; clips are added after them.
const defs = [svg.match(/<defs>([\s\S]*?)<\/defs>/)?.[1] ?? ''];
cut.shared ??= [];
cut.ink ??= [];
const clip = (id, d) => {
    defs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    return `url(#${id})`;
};
// An eye's white clips its pupil and lid.
const shapeClip = (id, i) => {
    defs.push(`<clipPath id="${id}">${el(i).replace(/\sfill="[^"]+"/, '')}</clipPath>`);
    return `url(#${id})`;
};

const group = (name, inner, attrs = '') => `<g data-rig="${name}"${attrs}>${inner.join('')}</g>`;

const out = [];
const eyeLayer = (eye) => {
    const c = shapeClip(`${eye.name}-white`, eye.white);
    // The lid is the white in skin color, a little larger so no rim of white
    // shows when it's shut; the ink drawn after it covers its edge.
    const lid = el(eye.white).replace(/fill="[^"]+"/, `fill="${eye.lid}" stroke="${eye.lid}" stroke-width="0.7"`);
    // It starts open: scaled to nothing about its top edge.
    const ty = eye.lidPivot[1];
    return (
        el(eye.white) +
        `<g clip-path="${c}">` +
        group(`${eye.name}-pupil`, eye.pupil.map(el)) +
        `</g>` +
        group(`${eye.name}-lid`, [lid], ` transform="matrix(1 0 0 0.001 0 ${(ty * 0.999).toFixed(3)})"`)
    );
};
// A part's layers, back to front: a shape's index, 'base' (the shared base
// fill), 'ink' (the shared ink, clipped to the part's ink region), raw SVG (a
// patch), { eye }, { part } (a child part, with its own regions), or
// { clip: region, layers } (shapes cut to a region: a shape that spans two
// parts, its outline stroke included, goes in each, cut).
let clips = 0;
function layers(part) {
    const inner = [];
    // Everything but the ink stays inside the part's fill region, so a part's
    // shading never spills over a neighbor's outline.
    let fills = [];
    const fillClip = part.base && clip(`${part.name}-fill`, poly(part.base));
    const flush = () => {
        if (!fills.length) {
            return;
        }
        inner.push(fillClip ? `<g clip-path="${fillClip}">${fills.join('')}</g>` : fills.join(''));
        fills = [];
    };
    for (const layer of part.layers) {
        if (typeof layer === 'number') {
            fills.push(el(layer));
        } else if (layer === 'base') {
            for (const i of cut.shared) {
                fills.push(el(i));
            }
        } else if (layer === 'ink') {
            flush();
            const c = clip(`${part.name}-ink`, poly(grow(part.ink, part.grow ?? 0)));
            for (const i of cut.ink) {
                inner.push(`<g clip-path="${c}">${el(i)}</g>`);
            }
        } else if (typeof layer === 'string') {
            fills.push(layer);
        } else if (layer.eye) {
            fills.push(eyeLayer(layer.eye));
        } else if (layer.clip) {
            const c = clip(`${part.name}-cut${clips++}`, poly(grow(layer.clip, layer.grow ?? 0)));
            fills.push(
                `<g clip-path="${c}">${layer.layers.map((i) => (typeof i === 'number' ? el(i) : i)).join('')}</g>`,
            );
        } else if (layer.part) {
            flush();
            inner.push(layers(layer.part));
        }
    }
    flush();
    return group(part.name, inner);
}
for (const part of cut.parts) {
    out.push(layers(part));
}

// Every shape must land somewhere exactly once (the ink and shared fills
// in every part, by design).
const used = new Map();
const count = (i) => typeof i === 'number' && used.set(i, (used.get(i) ?? 0) + 1);
// A shape cut into several parts is meant to appear in each.
const cutShapes = new Set();
const walk = (part) => {
    for (const layer of part.layers) {
        count(layer);
        if (layer?.eye) {
            [layer.eye.white, ...layer.eye.pupil].forEach(count);
        }
        if (layer?.clip) {
            layer.layers.forEach((i) => typeof i === 'number' && cutShapes.add(i));
        }
        if (layer?.part) {
            walk(layer.part);
        }
    }
};
cut.parts.forEach(walk);
const missing = elements
    .map((_, i) => i)
    .filter(
        (i) =>
            !used.has(i) &&
            !cutShapes.has(i) &&
            !cut.ink.includes(i) &&
            !cut.shared.includes(i) &&
            !(cut.drop ?? []).includes(i),
    );
const twice = [...used].filter(([, n]) => n > 1).map(([i]) => i);
if (missing.length || twice.length) {
    throw new Error(`${character}: unplaced ${missing.join(',') || '-'}; placed twice ${twice.join(',') || '-'}`);
}

const result =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none">` +
    `<defs>${defs.join('')}</defs>${out.join('')}</svg>\n`;
const target = join(root, 'packages/client/src/locals/art', `${character}.svg`);
writeFileSync(target, result);
console.log(`${character}: ${elements.length} shapes, ${cut.parts.length} parts, ${result.length} bytes → ${target}`);
