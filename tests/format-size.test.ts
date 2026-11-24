import { expect, it } from 'vitest';

import { formatSize } from '@socio/shared/text/format-size';

// One byte count for people, on the server (tool and filing text) and in the
// client (attachments and the Media page).

it('shows bytes, then whole kilobytes, then megabytes to one decimal', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('2 KB');
    expect(formatSize(1048575)).toBe('1024 KB');
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(32 * 1048576 + 1048576 / 4)).toBe('32.3 MB');
});
