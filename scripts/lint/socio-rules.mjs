// Socio's own lint rules, as an oxlint JS plugin (CB-311). `socio/locale`
// replaces the ESLint `no-restricted-syntax` selectors: text the server renders
// must sort and format the same in every browser, so one locale comes from
// packages/shared/src/locale.ts (en-US until i18n), and times go through <LocalTime>.
// `socio/hermes` keeps the native app off APIs its engine lacks (below).
// `socio/no-literal-text` and `socio/translate-in-components` hold translated
// client code to i18n's conventions (docs/I18N.md, at the end).

const property = (callee) =>
    callee?.type === 'MemberExpression' && !callee.computed ? callee.property?.name : undefined;

const intlCallee = (callee) =>
    callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' && callee.object.name === 'Intl';

/** `new Intl.X()` or `new Intl.X(undefined, …)`: the runtime's locale. */
const noLocale = (args) => args.length === 0 || (args[0].type === 'Identifier' && args[0].name === 'undefined');

const localeRule = {
    meta: {
        type: 'problem',
        docs: { description: 'Sort and format display text in the app locale.' },
        messages: {
            compare: 'Sort display text with compareText from packages/shared/src/locale.ts.',
            lower: 'Pass the locale: lowerText from packages/shared/src/locale.ts.',
            intl: 'Pass the locale: APP_LOCALE or numberFormat from packages/shared/src/locale.ts.',
        },
        schema: [],
    },
    create(context) {
        return {
            CallExpression(node) {
                const name = property(node.callee);
                if (name === 'localeCompare') {
                    context.report({ node, messageId: 'compare' });
                } else if (
                    (name === 'toLocaleLowerCase' || name === 'toLocaleUpperCase') &&
                    node.arguments.length === 0
                ) {
                    context.report({ node, messageId: 'lower' });
                }
            },
            NewExpression(node) {
                if (intlCallee(node.callee) && noLocale(node.arguments)) {
                    context.report({ node, messageId: 'intl' });
                }
            },
        };
    },
};

// The native app runs on Hermes, which lacks some APIs Node and the browsers
// have; a call compiles, then throws on the phone. On for apps/mobile and for
// packages/shared/src, whose source the app bundles (.oxlintrc.json). Ported
// from T3 Code's no-hermes-unsupported-apis rule (pingdotgg/t3code at
// 240446e2d9, MIT; THIRD_PARTY_NOTICES), with four globals added. Hermes has
// no crypto global, and react-native-get-random-values adds only
// getRandomValues. Intl.supportedValuesOf, structuredClone and Array.fromAsync
// are missing from the engine React Native 0.88 ships (hermes-android
// 260318099.0.5). Feature detection (`typeof Intl.Segmenter`) stays allowed;
// a guarded call takes an `oxlint-disable-next-line socio/hermes` comment. A
// global API is reported only when its first name is the global's: an import,
// a parameter or a declaration of that name (expo-crypto's `crypto`) is
// another implementation, and Hermes runs it. Not one that emits nothing (an
// ambient `declare`, an `import type`), and not a local taken from the global
// (`const { structuredClone } = globalThis`): those still reach the global.

const UNSUPPORTED_GLOBAL_APIS = new Map([
    ['Intl.Segmenter', 'Use a portable implementation or a simpler character-counting approximation.'],
    [
        'crypto.randomUUID',
        'In the app, use randomUUID from expo-crypto; shared code takes the id from its caller instead.',
    ],
    [
        'Intl.supportedValuesOf',
        "Check `typeof Intl.supportedValuesOf === 'function'` first, and work without the list when it isn't.",
    ],
    [
        'structuredClone',
        'Copy the value yourself: a spread for one level, or JSON.parse(JSON.stringify(value)) for plain data.',
    ],
    ['Array.fromAsync', 'Collect the items with a for await...of loop.'],
]);

const UNSUPPORTED_METHODS = new Map([
    ['toSorted', 'Hermes does not implement Array#toSorted. Copy the array first: [...array].sort(...).'],
    ['toReversed', 'Hermes does not implement Array#toReversed. Copy the array first: [...array].reverse().'],
    [
        'toSpliced',
        'Hermes does not implement Array#toSpliced. Copy the array first: const copy = [...array]; copy.splice(...); use copy.',
    ],
]);

/** A member's static name: `a.b`, `a['b']` and a template with no substitutions; otherwise null. */
const memberName = (node) => {
    const { property } = node;
    if (!node.computed && property.type === 'Identifier') {
        return property.name;
    }
    if (property.type === 'Literal' && typeof property.value === 'string') {
        return property.value;
    }
    if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
        return property.quasis[0]?.value.cooked ?? null;
    }
    return null;
};

/** The objects whose members are the globals: `globalThis.crypto` is `crypto`. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window']);

/** The path to member `name` of `path`, where a member of a global object is that global. */
const member = (path, name) => (GLOBAL_OBJECTS.has(path) ? name : `${path}.${name}`);

/** TypeScript around an expression, which emits nothing: `x as T`, `x satisfies T`, `x!`, `<T>x`. */
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

/**
 * A definition that emits nothing, so the name still reaches the global when the code runs:
 * ambient code (`declare const crypto: …`, `declare function structuredClone…`, `declare class`)
 * and a type-only import (`import type { … }`, `import { type … }`).
 */
const emitsNothing = (def) =>
    def.node.declare === true ||
    def.parent?.declare === true ||
    def.node.type === 'TSDeclareFunction' ||
    def.node.importKind === 'type' ||
    def.parent?.importKind === 'type';

/** A property key's static name: `a`, `'a'`; null when computed. */
const keyName = (property) => {
    if (property.computed) {
        return null;
    }
    const { key } = property;
    return key.type === 'Identifier' ? key.name : typeof key.value === 'string' ? key.value : null;
};

/**
 * The keys from a declarator's pattern down to the identifier `name`: [] for `const name = …`,
 * ['crypto', 'randomUUID'] for `const { crypto: { randomUUID: name } } = …`; null when it sits
 * under a default value, a rest element, an array pattern or a computed key.
 */
const keysTo = (pattern, name) => {
    if (pattern.type === 'Identifier') {
        return pattern.start === name.start && pattern.end === name.end ? [] : null;
    }
    if (pattern.type !== 'ObjectPattern') {
        return null;
    }
    for (const property of pattern.properties) {
        const key = property.type === 'Property' ? keyName(property) : null;
        const keys = key === null ? null : keysTo(property.value, name);
        if (keys !== null) {
            return [key, ...keys];
        }
    }
    return null;
};

/**
 * What a local holds when it is a copy taken from an expression, declared once with it and never
 * assigned again: the expression and the keys down to the local (`const crypto =
 * globalThis.crypto`, `const { structuredClone } = globalThis`). Null for any other binding: an
 * import, a parameter, a function or class, `const crypto = makeCrypto()` is a value of its own.
 */
const copyOf = (variable) => {
    const [def, ...more] = variable.defs;
    if (def?.type !== 'Variable' || more.length > 0 || !def.node.init) {
        return null;
    }
    if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
        return null;
    }
    const keys = keysTo(def.node.id, def.name);
    return keys === null ? null : { init: def.node.init, keys };
};

/** The variable oxlint's scope analysis resolves `identifier` to, or null for none (an undeclared global). */
const resolve = (sourceCode, identifier) =>
    sourceCode.getScope(identifier).references.find((reference) => reference.identifier === identifier)?.resolved ??
    null;

/**
 * The global API a static member chain names, if it starts from the global: `Intl.Segmenter` for
 * `Intl.Segmenter`, `globalThis.Intl.Segmenter`, `window['Intl'].Segmenter` and the like, and for
 * a chain through a copy taken from the global (`const { Intl } = globalThis; Intl.Segmenter`).
 * Null for anything dynamic, and for a chain from a binding of its own: oxlint's ESLint-compatible
 * scope analysis, which hoists `var` and function declarations, resolves its first name to an
 * import, a parameter, a variable, function or class, or a catch parameter in an enclosing scope,
 * other than one that emits nothing (emitsNothing). An undeclared name resolves to no variable, an
 * environment global to one with no definition. `sourceCode.isGlobalReference` won't do: it is
 * false for any global the config's environments don't list, `crypto` and `structuredClone` among
 * them.
 */
const globalApi = (sourceCode, node, seen = new Set()) => {
    if (TS_WRAPPERS.has(node.type)) {
        return globalApi(sourceCode, node.expression, seen);
    }
    if (node.type === 'MemberExpression') {
        const name = memberName(node);
        const object = name === null ? null : globalApi(sourceCode, node.object, seen);
        return object === null ? null : member(object, name);
    }
    if (node.type !== 'Identifier') {
        return null;
    }
    const variable = resolve(sourceCode, node);
    if (variable === null || variable.defs.every(emitsNothing)) {
        return node.name;
    }
    const copy = seen.has(variable) ? null : copyOf(variable);
    if (copy === null) {
        return null;
    }
    seen.add(variable);
    const from = globalApi(sourceCode, copy.init, seen);
    return from === null ? null : copy.keys.reduce(member, from);
};

const hermesRule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow APIs that Hermes does not implement, in the native app and the shared code it bundles.',
        },
        messages: {
            global: 'Hermes does not implement {{path}}. {{replacement}}',
            method: '{{message}}',
        },
        schema: [],
    },
    create(context) {
        const check = (node) => {
            const path = globalApi(context.sourceCode, node.callee);
            const replacement = path === null ? undefined : UNSUPPORTED_GLOBAL_APIS.get(path);
            if (replacement !== undefined) {
                context.report({ node: node.callee, messageId: 'global', data: { path, replacement } });
                return;
            }
            if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
                return;
            }
            const name = memberName(node.callee);
            const message = name === null ? undefined : UNSUPPORTED_METHODS.get(name);
            if (message !== undefined) {
                context.report({ node: node.callee.property, messageId: 'method', data: { message } });
            }
        };
        return { CallExpression: check, NewExpression: check };
    },
};

// `socio/no-literal-text`: in a surface that has moved to i18n, every word a
// person reads comes from `t()` (docs/I18N.md). It flags JSX text with a letter
// in it, and the attributes people read or hear (aria-label, title,
// placeholder, alt, label) given a literal. On only for the folders listed in
// its .oxlintrc.json override: the list grows as surfaces migrate, and never
// shrinks (tests/integration/i18n-lint.test.ts).
const LETTER = /\p{L}/u;
const READ_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label']);

/** A string the code spells out: a literal, or a template with no substitutions. */
const literalText = (node) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0]?.value.cooked ?? '';
    }
    return null;
};

const noLiteralTextRule = {
    meta: {
        type: 'problem',
        docs: { description: 'Text people read comes from t() in a translated surface.' },
        messages: {
            text: 'Translate this text: t() from useTranslation() (docs/I18N.md).',
            attribute: 'Translate {{name}}: t() from useTranslation() (docs/I18N.md).',
        },
        schema: [],
    },
    create(context) {
        return {
            JSXText(node) {
                if (LETTER.test(node.value)) {
                    context.report({ node, messageId: 'text' });
                }
            },
            JSXExpressionContainer(node) {
                // `{'Save'}` as a child is text too.
                const text = node.parent?.type === 'JSXAttribute' ? null : literalText(node.expression);
                if (text !== null && LETTER.test(text)) {
                    context.report({ node, messageId: 'text' });
                }
            },
            JSXAttribute(node) {
                const name = node.name?.type === 'JSXIdentifier' ? node.name.name : null;
                if (!name || !READ_ATTRIBUTES.has(name)) {
                    return;
                }
                const value = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value;
                const text = literalText(value);
                if (text !== null && LETTER.test(text)) {
                    context.report({ node, messageId: 'attribute', data: { name } });
                }
            },
        };
    },
};

// `socio/translate-in-components`: `t` comes from `useTranslation()` inside a
// component or a hook, never from an instance at module level or in a plain
// helper. A `t` taken once doesn't follow a language change, and the React
// Compiler memoizes values, so one captured outside React would keep the old
// words. It flags `i18n.t(...)`, `i18next.t(...)`, `getFixedT(...)` and a call
// of `t` whose nearest named function isn't a component (PascalCase) or a hook
// (`useX`), or that has none (module level).
const COMPONENT_OR_HOOK = /^(?:use[A-Z0-9]|[A-Z])/;
const INSTANCE_NAMES = new Set(['i18n', 'i18next', 'instance']);

/** The name a function goes by: its own, or the variable, property or export it is assigned to. */
const functionName = (fn) => {
    if (fn.id?.name) {
        return fn.id.name;
    }
    const parent = fn.parent;
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        return parent.id.name;
    }
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.type === 'Identifier') {
        return parent.key.name;
    }
    // memo(function …) / forwardRef((props) => …): the component is the call's variable.
    if (parent?.type === 'CallExpression') {
        return functionName(parent);
    }
    return null;
};

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Whether a component or hook encloses the node. */
const insideComponentOrHook = (node) => {
    for (let at = node.parent; at; at = at.parent) {
        if (FUNCTIONS.has(at.type)) {
            const name = functionName(at);
            if (name && COMPONENT_OR_HOOK.test(name)) {
                return true;
            }
        }
    }
    return false;
};

const translateInComponentsRule = {
    meta: {
        type: 'problem',
        docs: { description: 't comes from useTranslation() in a component or hook.' },
        messages: {
            instance: 'Take t from useTranslation() in the component or hook instead of {{callee}} (docs/I18N.md).',
            outside: 'Call t inside a component or hook, from useTranslation() (docs/I18N.md).',
        },
        schema: [],
    },
    create(context) {
        return {
            CallExpression(node) {
                const { callee } = node;
                if (callee.type === 'MemberExpression' && !callee.computed) {
                    const name = callee.property?.name;
                    const object = callee.object?.type === 'Identifier' ? callee.object.name : null;
                    if ((name === 't' && object && INSTANCE_NAMES.has(object)) || name === 'getFixedT') {
                        context.report({ node, messageId: 'instance', data: { callee: `${object ?? '…'}.${name}` } });
                    }
                    return;
                }
                if (callee.type === 'Identifier' && (callee.name === 't' || callee.name === 'getFixedT')) {
                    if (callee.name === 'getFixedT') {
                        context.report({ node, messageId: 'instance', data: { callee: 'getFixedT' } });
                    } else if (!insideComponentOrHook(node)) {
                        context.report({ node, messageId: 'outside' });
                    }
                }
            },
        };
    },
};

export default {
    meta: { name: 'socio' },
    rules: {
        locale: localeRule,
        hermes: hermesRule,
        'no-literal-text': noLiteralTextRule,
        'translate-in-components': translateInComponentsRule,
    },
};
