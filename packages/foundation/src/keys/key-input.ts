// A data key from stdin, for the CLIs that take one (CB-322): `key-id-cli`
// and `backup-cli verify-key`. Typed or pasted at a terminal, it isn't
// echoed; piped, the key is the first line that isn't blank. Never an
// argument, so it stays out of shell history and the process list.

/** One line from the terminal, not echoed; Ctrl-C or Ctrl-D gives up. */
function readHidden(prompt: string): Promise<string> {
    return new Promise((done, fail) => {
        const input = process.stdin;
        let text = '';
        process.stderr.write(prompt);
        input.setRawMode(true);
        input.setEncoding('utf8');
        const finish = (error?: Error) => {
            input.setRawMode(false);
            input.pause();
            input.off('data', onData);
            process.stderr.write('\n');
            if (error) {
                fail(error);
            } else {
                done(text);
            }
            text = '';
        };
        const onData = (chunk: string) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    finish();
                    return;
                }
                if (char === '\u0003' || char === '\u0004') {
                    finish(new Error('No key given.'));
                    return;
                }
                text = char === '\u007f' || char === '\b' ? text.slice(0, -1) : text + char;
            }
        };
        input.on('data', onData);
        input.resume();
    });
}

/** Everything piped in; the key is its first line that isn't blank. */
async function readPiped(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const all = Buffer.concat(chunks);
    const text = all.toString('utf8');
    all.fill(0);
    for (const chunk of chunks) {
        chunk.fill(0);
    }
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ''
    );
}

/** The key's text from stdin; throws when none was given. */
export async function readKeyFromStdin(prompt = 'Data key (not shown as you type), then Enter: '): Promise<string> {
    const text = process.stdin.isTTY ? await readHidden(prompt) : await readPiped();
    if (!text.trim()) {
        throw new Error('No key given on stdin.');
    }
    return text;
}
