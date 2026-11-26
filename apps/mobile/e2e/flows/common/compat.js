// Maestro's JavaScript (GraalJS): one POST to servers.mjs's control port (SERVERS_CONTROL from
// run.mjs: 4549 unless --servers-control says otherwise), which restarts the workspaces with the
// query ${QUERY} (servers.mjs restartOptions: `minimum=`, `recommended=`, `version=<letter>:<x.y.z>`;
// empty is back to the defaults), CB-553.
var response = http.post('http://localhost:' + SERVERS_CONTROL + '/restart?' + QUERY, { body: '' });
if (response.status !== 200) {
    throw new Error('servers.mjs restart answered ' + response.status);
}
