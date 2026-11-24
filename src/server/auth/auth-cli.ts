// Account administration for AUTH_PROVIDER=betterauth, run on the server
// (in the container: node dist/server/server/auth/auth-cli.js …). Creates the
// first admin and test accounts, makes password links, and deactivates
// and reactivates people:
//   create-user --email E --name N [--role operator|admin|member] [--link USER_ID] [--password-file F]
//   password-link --email E
//   deactivate --email E | reactivate --email E
//   list
// Uses the same environment as the server (APP_ORIGIN, SESSION_SECRET, …).
import '@socio/foundation/no-vendor-telemetry';
import '@socio/foundation/keys/load-secret-files';
import { authCli } from './cli.js';

authCli(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed.');
    process.exit(1);
});
