// Side-effect import, second in index.ts: settings from `<NAME>_FILE`
// secrets must be in the environment before anything reads them.
import { loadSecretFiles } from './secret-files.js';

loadSecretFiles();
