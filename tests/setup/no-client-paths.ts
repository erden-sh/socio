import { join, resolve, sep } from 'node:path';

// What the server bucket can't reach: the client, and the plugin UI, which
// imports the client's components. Tests that do belong in tests/integration.
const root = join(import.meta.dirname, '../..');
const CLIENT_SIDE = ['packages/client', 'packages/plugin-ui'].map((dir) => join(root, dir));

export const isClientSide = (path: string) => {
    const full = resolve(root, path);
    return CLIENT_SIDE.some((dir) => full === dir || full.startsWith(`${dir}${sep}`));
};

export const reachMessage = (path: string) =>
    `A test in the server bucket reached ${path}. Client changes don't rerun that bucket, so this test could stay green on a broken client: move it to tests/integration (AGENTS.md, "Checks").`;
