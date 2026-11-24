/**
 * The Locals' rig (Manny, Mingo, Sebas, Rulo): each character's SVG is split
 * into parts, `<g data-rig="…">`, each with a joint (its pivot) and an
 * optional parent. A character's motion gives every part a target pose for
 * the current state, the rig moves each channel there on a spring (so state
 * changes blend and heavy parts lag behind light ones), and composes each
 * part with its parent's, so a claw follows its arm and a tail its body even
 * though the art's groups are flat.
 *
 * One animation frame loop drives every mounted rig; a rig that is off
 * screen, or in a hidden tab, isn't stepped. With reduced motion a rig shows
 * its state's still pose and never animates.
 */

export type Vec = [number, number];

/** The states the app shows a Local in (Mascot's `state`). */
export const RIG_STATES = ['idle', 'working', 'waiting', 'needs', 'done', 'paused'] as const;
export type RigState = (typeof RIG_STATES)[number];

/** One part's offsets from its rest pose, in the art's units. */
export interface Channels {
    tx?: number;
    ty?: number;
    /** Degrees, clockwise. */
    r?: number;
    sx?: number;
    sy?: number;
}
export type Pose = Record<string, Channels>;

export interface PartSpec {
    /** The joint the part turns and scales about, in the art's units. */
    pivot: Vec;
    parent?: string;
    /** How stiff its springs are: higher follows faster (default 170). */
    stiffness?: number;
    /** How quickly it settles: lower overshoots more (default 26). */
    damping?: number;
    /**
     * The part sits inside its parent's group in the art (an eye's pupil inside
     * the head, under the eye's clip), so it gets only its own motion.
     */
    nested?: boolean;
}

/** What a character's motion knows each frame. */
export interface MotionContext {
    state: RigState;
    /** Seconds since the rig started. */
    t: number;
    /** Seconds since this state began. */
    since: number;
    /** Where the eyes are looking, -1..1 each way (0, 0 is the viewer). */
    gaze: Vec;
    /** 0 open, 1 shut. */
    blink: number;
    /** A part channel's current value, for follow-through (a tail on a body). */
    current(part: string, channel: keyof Channels): number;
    /** A smooth noise in -1..1 that differs per seed. */
    noise(seed: number, speed?: number): number;
}

export interface GazeStep {
    at: Vec;
    /** Seconds to hold it. */
    hold: number;
}

export interface CharacterRig {
    /** Still artwork needs no springs or per-frame DOM writes. */
    static?: boolean;
    id: string;
    name: string;
    /** The art, with `data-rig` on every part. */
    svg: string;
    parts: Record<string, PartSpec>;
    motion(ctx: MotionContext): Pose;
    /**
     * Where the eyes go in a state: a scripted loop, or none for the default
     * glances. `waiting` usually looks left, then right.
     */
    gaze?: Partial<Record<RigState, GazeStep[]>>;
}

type Spring = { x: number; v: number };
const REST: Required<Channels> = { tx: 0, ty: 0, r: 0, sx: 1, sy: 1 };
const KEYS = Object.keys(REST) as (keyof Channels)[];

/** A 2D affine matrix, [a b c d e f] as in SVG's `matrix()`. */
type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];
function local([px, py]: Vec, c: Required<Channels>): Matrix {
    const a = (c.r * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // translate(pivot + t) · rotate · scale · translate(-pivot)
    const m: Matrix = [cos * c.sx, sin * c.sx, -sin * c.sy, cos * c.sy, 0, 0];
    m[4] = px + c.tx - (m[0] * px + m[2] * py);
    m[5] = py + c.ty - (m[1] * px + m[3] * py);
    return m;
}

/** Smooth value noise: a few incommensurate sines, cheap and seamless. */
function noise(t: number, seed: number) {
    return (
        (Math.sin(t * 1.37 + seed * 12.9) +
            Math.sin(t * 2.71 + seed * 78.2) * 0.6 +
            Math.sin(t * 4.13 + seed * 37.7) * 0.3) /
        1.9
    );
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export class Rig {
    private parts: [string, PartSpec, SVGGElement][] = [];
    private springs = new Map<string, Record<keyof Channels, Spring>>();
    private state: RigState = 'idle';
    private stateAt = 0;
    private t = 0;
    private gaze: Vec = [0, 0];
    private gazeTarget: Vec = [0, 0];
    private gazeUntil = 0;
    private gazeStep = 0;
    private blinkAt = 1.5;
    private blinkPhase = -1;
    private doubleBlink = false;
    visible = true;

    constructor(
        private readonly rig: CharacterRig,
        root: SVGSVGElement,
        private readonly seed: number,
    ) {
        for (const [name, spec] of Object.entries(rig.parts)) {
            const el = root.querySelector<SVGGElement>(`[data-rig="${name}"]`);
            if (!el) {
                continue;
            }
            this.parts.push([name, spec, el]);
            this.springs.set(
                name,
                Object.fromEntries(KEYS.map((k) => [k, { x: REST[k], v: 0 }])) as Record<keyof Channels, Spring>,
            );
        }
        // Parents before children, so a child composes its parent's matrix.
        const depth = (n: string): number => (rig.parts[n]?.parent ? 1 + depth(rig.parts[n].parent!) : 0);
        this.parts.sort((a, b) => depth(a[0]) - depth(b[0]));
        this.blinkAt = 0.8 + (seed % 7) * 0.4;
    }

    setState(state: RigState) {
        if (state === this.state) {
            return;
        }
        this.state = state;
        this.stateAt = this.t;
        this.gazeStep = 0;
        this.gazeUntil = this.t;
    }

    /** The state's still pose, for reduced motion and the server's render. */
    still() {
        this.t = 0;
        this.stateAt = 0;
        this.gaze = this.gazeTarget = [0, 0];
        this.apply(this.targets(0), true);
    }

    step(dt: number) {
        this.t += dt;
        this.updateGaze(dt);
        this.updateBlink(dt);
        const target = this.targets(this.blinkAmount());
        // Springs, in small steps so stiff parts stay stable on a slow frame.
        const n = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / n;
        for (const [name, spec] of this.parts) {
            const s = this.springs.get(name)!;
            const k = spec.stiffness ?? 170;
            const d = spec.damping ?? 26;
            for (const key of KEYS) {
                const goal = target[name]?.[key] ?? REST[key];
                const sp = s[key];
                for (let i = 0; i < n; i++) {
                    sp.v += (k * (goal - sp.x) - d * sp.v) * h;
                    sp.x += sp.v * h;
                }
            }
        }
        this.apply(target, false);
    }

    private targets(blink: number): Pose {
        return this.rig.motion({
            state: this.state,
            t: this.t,
            since: this.t - this.stateAt,
            gaze: this.gaze,
            blink,
            current: (part, ch) => this.springs.get(part)?.[ch].x ?? REST[ch],
            noise: (seed, speed = 1) => noise(this.t * speed, seed + this.seed),
        });
    }

    private apply(pose: Pose, snap: boolean) {
        const world = new Map<string, Matrix>();
        for (const [name, spec, el] of this.parts) {
            const s = this.springs.get(name)!;
            const c = { ...REST };
            for (const key of KEYS) {
                if (snap) {
                    s[key].x = pose[name]?.[key] ?? REST[key];
                }
                c[key] = s[key].x;
            }
            const own = local(spec.pivot, c);
            const parent = spec.parent && world.get(spec.parent);
            const m = parent ? multiply(parent, own) : own;
            world.set(name, m);
            const shown = spec.nested ? own : m;
            el.setAttribute('transform', `matrix(${shown.map((v) => +v.toFixed(4)).join(' ')})`);
        }
    }

    private updateGaze(dt: number) {
        const script = this.rig.gaze?.[this.state];
        if (this.t >= this.gazeUntil) {
            if (script?.length) {
                const step = script[this.gazeStep % script.length];
                this.gazeStep++;
                this.gazeTarget = step.at;
                this.gazeUntil = this.t + step.hold;
            } else if (this.state === 'paused') {
                this.gazeTarget = [0, 0.2];
                this.gazeUntil = this.t + 5;
            } else {
                // Glances: mostly at the viewer, sometimes away, never still long.
                const away = Math.random() < 0.45;
                this.gazeTarget = away
                    ? [Math.random() * 1.6 - 0.8, Math.random() * 0.8 - 0.4]
                    : [Math.random() * 0.2 - 0.1, Math.random() * 0.2 - 0.1];
                this.gazeUntil = this.t + (away ? 0.7 + Math.random() * 1.2 : 1.6 + Math.random() * 2.8);
            }
        }
        // Eyes move in quick saccades: fast spring toward the target.
        const a = 1 - Math.exp(-dt * 22);
        this.gaze = [
            this.gaze[0] + (this.gazeTarget[0] - this.gaze[0]) * a,
            this.gaze[1] + (this.gazeTarget[1] - this.gaze[1]) * a,
        ];
    }

    private updateBlink(dt: number) {
        if (this.blinkPhase >= 0) {
            this.blinkPhase += dt / 0.16;
            if (this.blinkPhase >= 1) {
                this.blinkPhase = -1;
                if (this.doubleBlink) {
                    this.doubleBlink = false;
                    this.blinkAt = this.t + 0.12;
                } else {
                    this.blinkAt = this.t + 2.2 + Math.random() * 4;
                }
            }
        } else if (this.t >= this.blinkAt) {
            this.blinkPhase = 0;
            this.doubleBlink = Math.random() < 0.2;
        }
    }

    private blinkAmount() {
        if (this.blinkPhase < 0) {
            return 0;
        }
        // Shut quickly, open a little slower.
        const p = this.blinkPhase;
        return p < 0.4 ? ease(p / 0.4) : 1 - ease((p - 0.4) / 0.6);
    }
}

/* The loop every mounted rig shares. */
const rigs = new Set<Rig>();
let frame = 0;
let last = 0;
/** Bounded on phones with both 60 Hz and 120 Hz screens. */
export const RIG_FRAME_MS = 1000 / 30;
function tick(now: number) {
    if (last && now - last < RIG_FRAME_MS - 1) {
        frame = rigs.size ? requestAnimationFrame(tick) : 0;
        return;
    }
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    if (document.visibilityState === 'visible') {
        for (const rig of rigs) {
            if (rig.visible) {
                rig.step(dt);
            }
        }
    }
    frame = rigs.size ? requestAnimationFrame(tick) : 0;
}
export function run(rig: Rig) {
    rigs.add(rig);
    if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
    }
    return () => {
        rigs.delete(rig);
    };
}

/** Makes the art's ids unique per instance, so two avatars never share a gradient. */
export function scopeIds(svg: string, prefix: string) {
    return svg
        .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
        .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
        .replace(/(xlink:)?href="#([^"]+)"/g, `$1href="#${prefix}$2"`);
}

/* Helpers characters' motions share. */
export const wave = (t: number, period: number, phase = 0) => Math.sin(((t / period + phase) % 1) * Math.PI * 2);
/** 0..1..0 over `length` seconds, every `period`. */
export function pulse(t: number, period: number, length: number, offset = 0) {
    const p = (((t - offset) % period) + period) % period;
    return p < length ? Math.sin((p / length) * Math.PI) : 0;
}
/** 0..1 once, `delay` seconds into a state, over `length`. */
export const enter = (since: number, length: number, delay = 0) =>
    ease(Math.min(1, Math.max(0, (since - delay) / length)));
