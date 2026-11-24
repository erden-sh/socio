// The superellipse behind a squircle, kept free of React Native so Node tests can check it.

/** The exponent: 2 is a circle; around 5 gives the iOS icon's shape. */
export const EXPONENT = 5;
const STEPS = 64;

/** The superellipse inside a `size` square, as an SVG path. */
export function squirclePath(size: number, exponent = EXPONENT): string {
    const r = size / 2;
    const points: string[] = [];
    for (let i = 0; i < STEPS; i += 1) {
        const t = (i / STEPS) * 2 * Math.PI;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        const x = r + r * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
        const y = r + r * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return `M${points.join('L')}Z`;
}
