// node dist/server/server/keys/key-id-cli.js (CB-322): prints a data key's id,
// the fingerprint Service setup and /healthz show for DATA_ENCRYPTION_KEY
// and DATA_ENCRYPTION_KEY_PREVIOUS, so an escrowed copy of the key can be
// checked against the running app without showing the key to anyone.
//
// The key comes on stdin: typed or pasted at the terminal (not echoed), or
// piped (`node … < key.txt`). It is never an argument, so it stays out of
// the shell's history and the process list. Offline: nothing here opens a
// connection, reads the environment or writes a file.
import { keyIdFromText } from '@socio/foundation/keys/data-keys';
import { readKeyFromStdin } from '@socio/foundation/keys/key-input';

try {
    console.log(keyIdFromText(await readKeyFromStdin()));
} catch (error) {
    // parseDataKey's errors never echo the key.
    console.error(`Key id failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
}
