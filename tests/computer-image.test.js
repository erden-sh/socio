import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const TAG = 'company-brain-computer:b6932d3-isolated-v2';

// CB-130: a socio's computer had no git. The image build runs git, and every
// place that names the image names the new tag, so computers are re-created.
it('installs git in the computer image and checks it runs', () => {
    const dockerfile = read('deployment/computers/computer.Dockerfile');
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends git ca-certificates/);
    expect(dockerfile).toMatch(/rm -rf \/var\/lib\/apt\/lists/);
    expect(dockerfile).toMatch(/&& git --version/);
});

it.each(['scripts/build-images.mjs', '.docker/compose.computers.yml', 'deployment/computers/README.md'])(
    '%s names the computer image tag with git',
    (path) => {
        const text = read(path);
        expect(text).toContain(TAG);
        expect(text).not.toMatch(/b6932d3-browser-limits(?!-git)/);
    },
);
