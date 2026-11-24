import { createRequire } from 'node:module';
import { join } from 'node:path';

// The class names a source file writes, read from Babel's AST: every string
// given to a `className` or `*ClassName` prop and to `cx(...)`, followed through
// what those name in the same file: a conditional's two sides, `a && 'x'`, a
// const, and the maps the primitives keep their looks in (`TONES[tone]`,
// `look.box` from `const look = TONES[tone]`, which takes `box` from every
// entry). A parameter is the caller's: its class names are read where they're
// written. Anything else in those places throws, so no class name goes
// unchecked because this couldn't read it. Class names are always written in
// full (Tailwind finds them in the source), which is what makes this reliable.

interface AstNode {
    readonly type: string;
    readonly loc?: { readonly start: { readonly line: number } } | null;
    readonly [key: string]: unknown;
}

/** The part of Babel's NodePath and Binding used here. */
interface AstPath {
    readonly node: AstNode;
    readonly scope: { readonly getBinding: (name: string) => { kind: string; path: AstPath } | undefined };
    readonly get: (key: string) => AstPath | AstPath[];
}

const babel: {
    parseSync: (source: string, options: Record<string, unknown>) => AstNode | null;
    traverse: (ast: AstNode, visitors: { readonly enter: (path: AstPath) => void }) => void;
} = createRequire(join(import.meta.dirname, '../../package.json'))('@babel/core');

export interface ClassNameUse {
    readonly name: string;
    readonly file: string;
    readonly line: number;
}

const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);

const one = (path: AstPath, key: string) => {
    const child = path.get(key);
    if (Array.isArray(child)) {
        throw new Error(`${key} is a list`);
    }
    return child;
};

const many = (path: AstPath, key: string) => {
    const children = path.get(key);
    return Array.isArray(children) ? children : [children];
};

const isClassNameProp = (name: string) => name === 'className' || name.endsWith('ClassName');

const isCx = (node: AstNode) => {
    const callee = node.callee as AstNode | undefined;
    return node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === 'cx';
};

/** Every class name in `source`, with the file and line of the string that holds it. */
export function classNamesIn(source: string, file: string): ClassNameUse[] {
    const ast = babel.parseSync(source, {
        babelrc: false,
        configFile: false,
        filename: file,
        sourceType: 'module',
        parserOpts: { plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
    });
    if (ast === null) {
        throw new Error(`Babel gave no AST for ${file}`);
    }
    const unreadable = (path: AstPath) =>
        new Error(
            `${file}:${path.node.loc?.start.line ?? 0}: can't read the class names in this ${path.node.type}; write them out in full`,
        );

    /** The object literals an expression names: a literal, a const, or a map's entries. */
    const objects = (path: AstPath): AstPath[] => {
        const { node } = path;
        if (WRAPPERS.has(node.type)) {
            return objects(one(path, 'expression'));
        }
        if (node.type === 'ObjectExpression') {
            return [path];
        }
        if (node.type === 'Identifier') {
            return objects(constant(path));
        }
        if (node.type === 'MemberExpression') {
            return members(path).flatMap(objects);
        }
        throw unreadable(path);
    };

    /** The values `object.key` or `object[...]` can be: one property of each object, or all of them. */
    const members = (path: AstPath): AstPath[] => {
        const property = path.node.property as AstNode;
        const key = !path.node.computed
            ? (property.name as string)
            : property.type === 'StringLiteral'
              ? (property.value as string)
              : undefined;
        return objects(one(path, 'object')).flatMap((object) =>
            many(object, 'properties').flatMap((entry) => {
                if (entry.node.type !== 'ObjectProperty') {
                    throw unreadable(entry);
                }
                const name = entry.node.key as AstNode;
                const entryKey = name.type === 'Identifier' ? name.name : name.value;
                return key === undefined || key === entryKey ? [one(entry, 'value')] : [];
            }),
        );
    };

    /** The initializer of the const an identifier names. */
    const constant = (path: AstPath): AstPath => {
        const binding = path.scope.getBinding(path.node.name as string);
        if (binding?.kind !== 'const' || binding.path.node.type !== 'VariableDeclarator') {
            throw unreadable(path);
        }
        return one(binding.path, 'init');
    };

    const strings = (path: AstPath): { value: string; line: number }[] => {
        const { node } = path;
        const line = node.loc?.start.line ?? 0;
        if (WRAPPERS.has(node.type)) {
            return strings(one(path, 'expression'));
        }
        switch (node.type) {
            case 'StringLiteral':
                return [{ value: node.value as string, line }];
            case 'TemplateLiteral': {
                const [quasi] = node.quasis as { value: { cooked: string } }[];
                if ((node.expressions as unknown[]).length > 0 || quasi === undefined) {
                    throw unreadable(path);
                }
                return [{ value: quasi.value.cooked, line }];
            }
            case 'JSXExpressionContainer':
                return strings(one(path, 'expression'));
            case 'ConditionalExpression':
                return [...strings(one(path, 'consequent')), ...strings(one(path, 'alternate'))];
            case 'LogicalExpression':
                // `test && 'name'` writes only its right side; `a ?? 'name'` and `a || 'name'` either.
                return node.operator === '&&'
                    ? strings(one(path, 'right'))
                    : [...strings(one(path, 'left')), ...strings(one(path, 'right'))];
            case 'BooleanLiteral':
            case 'NullLiteral':
                return [];
            case 'Identifier': {
                if (node.name === 'undefined') {
                    return [];
                }
                const binding = path.scope.getBinding(node.name as string);
                return binding?.kind === 'param' ? [] : strings(constant(path));
            }
            case 'CallExpression':
                if (!isCx(node)) {
                    throw unreadable(path);
                }
                return many(path, 'arguments').flatMap(strings);
            case 'MemberExpression':
                return members(path).flatMap(strings);
            default:
                throw unreadable(path);
        }
    };

    const found = new Map<string, ClassNameUse>();
    const take = (path: AstPath) => {
        for (const { value, line } of strings(path)) {
            for (const name of value.split(/\s+/).filter(Boolean)) {
                found.set(`${line} ${name}`, { name, file, line });
            }
        }
    };
    babel.traverse(ast, {
        enter(path) {
            const { node } = path;
            if (node.type === 'JSXAttribute') {
                const name = node.name as AstNode;
                if (name.type === 'JSXIdentifier' && isClassNameProp(name.name as string) && node.value !== null) {
                    take(one(path, 'value'));
                }
            } else if (isCx(node)) {
                for (const argument of many(path, 'arguments')) {
                    take(argument);
                }
            }
        },
    });
    return [...found.values()];
}
