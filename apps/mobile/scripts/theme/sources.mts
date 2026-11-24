// What the theme generator reads, as text: the custom properties of a CSS
// block, var() references followed the way the browser follows them, the
// calc()s of the radius and type scales, and the Tailwind classes of the
// web's tone tiles (packages/client/src/shell/tones.ts).

/** A block's custom properties, by name without the leading `--`, values as written. */
export type Declarations = Record<string, string>;

/** Where the string opening at `start` closes: its closing quote's index, escapes skipped. */
function stringEnd(text: string, start: number): number {
    const quote = text[start];
    for (let index = start + 1; index < text.length; index += 1) {
        if (text[index] === '\\') {
            index += 1;
        } else if (text[index] === quote) {
            return index;
        }
    }
    throw new Error(`Unclosed string at "${text.slice(start, start + 40)}".`);
}

/** `css` with each comment replaced by a space. A `/*` inside a string is no comment. */
function uncommented(css: string): string {
    let result = '';
    for (let index = 0; index < css.length; index += 1) {
        const char = css[index]!;
        if (char === '"' || char === "'") {
            const end = stringEnd(css, index);
            result += css.slice(index, end + 1);
            index = end;
        } else if (char === '/' && css[index + 1] === '*') {
            const end = css.indexOf('*/', index + 2);
            if (end < 0) {
                throw new Error(`Unclosed comment at "${css.slice(index, index + 40)}".`);
            }
            result += ' ';
            index = end + 1;
        } else {
            result += char;
        }
    }
    return result;
}

/** A top-level rule: its prelude, whitespace collapsed, and what its braces hold. */
interface Rule {
    prelude: string;
    body: string;
}

/** A stylesheet's top-level rules, in source order. Statements (`@import …;`) aren't rules. */
function topLevelRules(css: string): Rule[] {
    const text = uncommented(css);
    const rules: Rule[] = [];
    let depth = 0;
    let preludeStart = 0;
    let bodyStart = 0;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (char === '"' || char === "'") {
            index = stringEnd(text, index);
        } else if (char === '{') {
            if (depth === 0) {
                bodyStart = index + 1;
            }
            depth += 1;
        } else if (char === '}') {
            if (depth === 0) {
                throw new Error(`A "}" closes nothing, after "${text.slice(Math.max(0, index - 40), index)}".`);
            }
            depth -= 1;
            if (depth === 0) {
                const prelude = text
                    .slice(preludeStart, bodyStart - 1)
                    .replace(/\s+/g, ' ')
                    .trim();
                rules.push({ prelude, body: text.slice(bodyStart, index) });
                preludeStart = index + 1;
            }
        } else if (char === ';' && depth === 0) {
            preludeStart = index + 1;
        }
    }
    if (depth > 0) {
        throw new Error(`"${text.slice(preludeStart, bodyStart).replace(/\s+/g, ' ').trim()}" never closes.`);
    }
    return rules;
}

/**
 * The custom properties a rule's body sets directly. Rules nested in it
 * (`@keyframes`) don't count; the last declaration may go without its `;`.
 */
function declarations(body: string): Declarations {
    const found: Declarations = {};
    let depth = 0;
    let statement = '';
    const take = () => {
        const match = /^\s*--([\w-]+)\s*:([\s\S]*)$/.exec(statement);
        if (match) {
            found[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim();
        }
        statement = '';
    };
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index]!;
        if (char === '"' || char === "'") {
            const end = stringEnd(body, index);
            if (depth === 0) {
                statement += body.slice(index, end + 1);
            }
            index = end;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                statement = '';
            }
        } else if (depth === 0) {
            if (char === ';') {
                take();
            } else {
                statement += char;
            }
        }
    }
    take();
    return found;
}

/**
 * The custom properties that every top-level rule for one of `selectors`
 * sets, merged in source order the way the cascade merges equally specific
 * rules: a later declaration wins, whichever rule it is in. A rule counts when
 * one of its comma-separated selectors is exactly one of `selectors`, so
 * `:root` inside `@media` doesn't, and neither does `html.dark`. Throws when
 * no rule counts.
 */
export function readCascade(css: string, selectors: readonly string[]): Declarations {
    const rules = topLevelRules(css).filter((rule) =>
        rule.prelude.split(',').some((selector) => selectors.includes(selector.trim())),
    );
    if (rules.length === 0) {
        throw new Error(`No top-level ${selectors.map((selector) => `"${selector} {"`).join(' or ')} block.`);
    }
    return Object.assign({}, ...rules.map((rule) => declarations(rule.body))) as Declarations;
}

/**
 * The custom properties of every top-level block with this prelude, merged:
 * `:root`, `.dark`, `@theme inline`, `@theme default` (not `@theme default
 * inline reference`). A second `.dark` block later in the file adds to the
 * first and wins where they differ, as it does in the browser.
 */
export const readBlock = (css: string, prelude: string): Declarations => readCascade(css, [prelude]);

/** Where a var() reference starts in `value`, with its name, fallback and end. */
function nextVar(value: string, from: number) {
    const start = value.indexOf('var(', from);
    if (start < 0) {
        return undefined;
    }
    let depth = 0;
    let comma = -1;
    for (let index = start + 3; index < value.length; index += 1) {
        const char = value[index];
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
            if (depth === 0) {
                const inner = value.slice(start + 4, index);
                const name = (comma < 0 ? inner : value.slice(start + 4, comma)).trim();
                const fallback = comma < 0 ? undefined : value.slice(comma + 1, index).trim();
                if (!name.startsWith('--')) {
                    throw new Error(`Bad var() in "${value}".`);
                }
                return { start, end: index + 1, name: name.slice(2), fallback };
            }
        } else if (char === ',' && depth === 1 && comma < 0) {
            comma = index;
        }
    }
    throw new Error(`Unclosed var() in "${value}".`);
}

/**
 * `name`'s value in `tokens` with every var() in it replaced, as the browser
 * computes a custom property: a reference takes the referenced property's
 * value, or its fallback when that property isn't set. A cycle, or a
 * reference to an unset property with no fallback, throws.
 */
export function resolve(tokens: Declarations, name: string, seen: readonly string[] = []): string {
    if (seen.includes(name)) {
        throw new Error(`var() cycle: --${[...seen, name].join(' → --')}`);
    }
    const value = tokens[name];
    if (value === undefined) {
        throw new Error(`--${name} isn't set${seen.length > 0 ? ` (from --${seen.at(-1)})` : ''}.`);
    }
    return substitute(tokens, value, [...seen, name]);
}

/** `value` with each var() in it replaced (resolve's work, for a value rather than a name). */
export function substitute(tokens: Declarations, value: string, seen: readonly string[] = []): string {
    let result = '';
    let from = 0;
    for (let ref = nextVar(value, 0); ref; ref = nextVar(value, from)) {
        result += value.slice(from, ref.start);
        if (tokens[ref.name] !== undefined) {
            result += resolve(tokens, ref.name, seen);
        } else if (ref.fallback !== undefined) {
            result += substitute(tokens, ref.fallback, seen);
        } else {
            resolve(tokens, ref.name, seen);
        }
        from = ref.end;
    }
    return result + value.slice(from);
}

/** A length in px or a plain number, as calc() computes them. */
interface Quantity {
    value: number;
    px: boolean;
}

/** One rem, in px: the browser default the web never changes. */
export const REM_PX = 16;

/**
 * A length or number (`0.6rem`, `13.6px`, `1.5`), or a calc() of them with
 * + - * / and parentheses, after var() substitution. Lengths come back in px.
 */
export function evaluate(text: string): Quantity {
    const tokens = text.match(/\d*\.?\d+(?:px|rem)?|[-+*/()]|calc\(/g) ?? [];
    if (tokens.join('') !== text.replace(/\s+/g, '')) {
        throw new Error(`Can't compute "${text}": only px, rem, numbers, + - * / and calc().`);
    }
    let at = 0;
    const primary = (): Quantity => {
        const token = tokens[at++];
        if (token === '(' || token === 'calc(') {
            const inner = sum();
            if (tokens[at++] !== ')') {
                throw new Error(`Unbalanced parentheses in "${text}".`);
            }
            return inner;
        }
        if (token === '-') {
            const negated = primary();
            return { value: -negated.value, px: negated.px };
        }
        const match = token === undefined ? null : /^(\d*\.?\d+)(px|rem)?$/.exec(token);
        if (!match) {
            throw new Error(`Can't compute "${text}" at "${token ?? 'its end'}".`);
        }
        const value = Number(match[1]);
        return match[2] === undefined
            ? { value, px: false }
            : { value: match[2] === 'rem' ? value * REM_PX : value, px: true };
    };
    const product = (): Quantity => {
        let left = primary();
        while (tokens[at] === '*' || tokens[at] === '/') {
            const op = tokens[at++];
            const right = primary();
            if (right.px && (op === '/' || left.px)) {
                throw new Error(`"${text}" multiplies or divides by a length.`);
            }
            left = { value: op === '*' ? left.value * right.value : left.value / right.value, px: left.px || right.px };
        }
        return left;
    };
    const sum = (): Quantity => {
        let left = product();
        while (tokens[at] === '+' || tokens[at] === '-') {
            const op = tokens[at++];
            const right = product();
            if (left.px !== right.px) {
                throw new Error(`"${text}" adds a length to a number.`);
            }
            left = { value: op === '+' ? left.value + right.value : left.value - right.value, px: left.px };
        }
        return left;
    };
    const result = sum();
    if (at !== tokens.length) {
        throw new Error(`Can't compute "${text}": "${tokens[at]}" is left over.`);
    }
    return result;
}

/** A length's px, rounded to 1/100 px. Throws for a plain number. */
export function px(text: string): number {
    const { value, px: isLength } = evaluate(text);
    if (!isLength) {
        throw new Error(`"${text}" isn't a length.`);
    }
    return round(value);
}

/** A plain number, rounded to 1/10000. Throws for a length. */
export function number(text: string): number {
    const { value, px: isLength } = evaluate(text);
    if (isLength) {
        throw new Error(`"${text}" is a length, not a number.`);
    }
    return Number(value.toFixed(4));
}

/** Rounded to 1/100: lengths in px. */
export const round = (value: number) => Number(value.toFixed(2));

/** A tone tile's paint in one scheme: a Tailwind color name and its opacity. */
export interface Paint {
    color: string;
    alpha: number;
}

export interface ToneClasses {
    background: Paint;
    foreground: Paint;
}

/**
 * The `toneTile` object's entries, `name: 'classes'` each, in order. Every
 * entry must read, or this throws: one it skipped would drop a tone without a
 * word. Comments may sit between entries, a key may be quoted, and oxfmt may
 * put a long value on the line after its key.
 */
function toneEntries(body: string): Array<[tone: string, classes: string]> {
    const text = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
    const entry = /\s*(?:([A-Za-z_$][\w$]*)|'([\w-]+)'|"([\w-]+)")\s*:\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)")\s*(?:,|$)/y;
    const entries: Array<[string, string]> = [];
    let at = 0;
    for (let match = entry.exec(text); match; match = entry.exec(text)) {
        const tone = (match[1] ?? match[2] ?? match[3])!;
        if (entries.some(([name]) => name === tone)) {
            throw new Error(`tones.ts sets the ${tone} tone twice.`);
        }
        entries.push([tone, (match[4] ?? match[5])!]);
        at = entry.lastIndex;
    }
    const rest = text.slice(at).trim();
    if (rest !== '') {
        throw new Error(
            `tones.ts has a toneTile entry the generator can't read: "${rest.split('\n')[0]}". ` +
                "Write each as name: 'classes', or teach readTones the new form.",
        );
    }
    return entries;
}

/**
 * Each tone's tile in light and dark, from tones.ts's class strings
 * (`bg-sky-500/12 text-sky-700 dark:text-sky-300`). A class without `dark:`
 * paints both schemes unless a `dark:` class of the same kind overrides it.
 */
export function readTones(source: string): Record<string, Record<'light' | 'dark', ToneClasses>> {
    const body = /toneTile[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
    if (body === undefined) {
        throw new Error('No `toneTile` object in tones.ts.');
    }
    const tones: Record<string, Record<'light' | 'dark', ToneClasses>> = {};
    for (const [tone, classes] of toneEntries(body)) {
        const paints: Record<string, Partial<Record<'background' | 'foreground', Paint>>> = { light: {}, dark: {} };
        const both: Partial<Record<'background' | 'foreground', Paint>> = {};
        for (const name of classes.split(/\s+/).filter(Boolean)) {
            const match = /^(dark:)?(bg|text)-([a-z]+(?:-[a-z\d]+)*)(?:\/(\d+))?$/.exec(name);
            if (!match) {
                throw new Error(`Unexpected class "${name}" in the ${tone} tone.`);
            }
            const kind = match[2] === 'bg' ? 'background' : 'foreground';
            const paint = { color: match[3]!, alpha: match[4] === undefined ? 1 : Number(match[4]) / 100 };
            if (match[1]) {
                paints.dark![kind] = paint;
            } else {
                both[kind] = paint;
            }
        }
        const scheme = (overrides: Partial<Record<'background' | 'foreground', Paint>>): ToneClasses => {
            const background = overrides.background ?? both.background;
            const foreground = overrides.foreground ?? both.foreground;
            if (!background || !foreground) {
                throw new Error(`The ${tone} tone needs a bg- and a text- class.`);
            }
            return { background, foreground };
        };
        tones[tone] = { light: scheme(paints.light!), dark: scheme(paints.dark!) };
    }
    if (Object.keys(tones).length === 0) {
        throw new Error('tones.ts has no tones.');
    }
    return tones;
}
