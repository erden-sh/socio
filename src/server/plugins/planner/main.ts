import { startPlanner } from './server.js';

/**
 * The social planner service. Socio's apps runtime starts one task per
 * replica. `CB_PLUGIN_PROOF` is how the task knows the request came through
 * the ingress. Posts are stored in Socio, so a replica holds nothing.
 */
const port = Number(process.env.PORT ?? 8080);
const proof = process.env.CB_PLUGIN_PROOF ?? '';
const apiUrl = process.env.SOCIO_API_URL ?? '';
// Its own identity; SOCIO_API_TOKEN_FILE (the shared PLUGIN_SERVICE_TOKEN)
// only until its first provision with one.
const tokenFile = process.env.SOCIO_IDENTITY_FILE || process.env.SOCIO_API_TOKEN_FILE || '';
if (!proof || !apiUrl || !tokenFile) {
    console.error('Social strategy needs PORT, CB_PLUGIN_PROOF, SOCIO_API_URL and SOCIO_IDENTITY_FILE.');
    process.exit(1);
}
startPlanner({ port, proof, apiUrl, tokenFile });
console.log(`Social strategy listening on ${port}`);
