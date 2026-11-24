import { readFileSync } from 'node:fs';

import { format, type FormatConfig } from 'oxfmt';

// The repo's formatter (oxfmt, CB-311) for text a test generates: snapshots
// and exports must match what `pnpm format` writes.
type Override = { files: string[]; options: FormatConfig };
const {
    $schema: _schema,
    ignorePatterns: _ignored,
    overrides = [],
    ...config
} = JSON.parse(readFileSync(new URL('../../.oxfmtrc.json', import.meta.url), 'utf8')) as FormatConfig & {
    $schema?: string;
    ignorePatterns?: string[];
    overrides?: Override[];
};

/** A config glob (`*.json`, `**\/*.json`) as a test on a file name. */
const glob = (pattern: string) =>
    new RegExp(
        `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*\//g, '(?:.*/)?')
            .replace(/\*/g, '[^/]*')}$`,
    );

/** The config for `fileName`: the base, then each matching override, in order (the CLI's rule). */
const configFor = (fileName: string): FormatConfig =>
    overrides
        .filter(({ files }) => files.some((pattern) => glob(pattern).test(fileName)))
        .reduce<FormatConfig>((merged, { options }) => ({ ...merged, ...options }), config);

/** `text` formatted as `pnpm format` would format a file named `fileName`. */
export async function formatAs(fileName: string, text: string) {
    const result = await format(fileName, text, configFor(fileName));
    if (result.errors.length) {
        throw new Error(
            `oxfmt could not format ${fileName}: ${result.errors.map((error) => error.message).join('; ')}`,
        );
    }
    return result.code;
}
