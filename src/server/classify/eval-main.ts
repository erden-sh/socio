// The evaluation command (CB-198): `pnpm run classify:eval -- --use=failures
// --provider=workspace` in a checkout, or in the app's image
// `node dist/server/server/classify/eval-main.js --use=failures`.
import { runEvalCli } from './eval-cli.js';

try {
    process.exitCode = await runEvalCli(process.argv.slice(2));
} catch (error) {
    console.error(`Evaluation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
}
