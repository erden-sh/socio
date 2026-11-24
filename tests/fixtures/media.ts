/** A real 1×1 PNG, for attachment tests. */
export const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/** A PNG-sniffed image of `size` bytes (the signature, then filler). */
export const pngOf = (size: number, fill = 1) =>
    Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(Math.max(0, size - 8), fill)]);
