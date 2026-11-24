/** Round axis ticks (0, 250, 500…) covering min..max. */
export function niceTicks(min: number, max: number, count = 4) {
    if (min === max) {
        if (min === 0) {
            max = 1;
        } else if (min > 0) {
            min = 0;
        } else {
            max = 0;
        }
    }
    const raw = (max - min) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / magnitude;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) {
        ticks.push(Math.round(v / step) * step);
    }
    return ticks;
}

/** A bar with a 4px rounded data end, square at the baseline. */
export function barPath(x: number, base: number, end: number, width: number) {
    const r = Math.min(4, width / 2, Math.abs(base - end));
    if (end <= base) {
        return `M${x},${base}V${end + r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end + r}V${base}Z`;
    }
    return `M${x},${base}V${end - r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end - r}V${base}Z`;
}
