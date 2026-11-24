// Maestro's JavaScript (GraalJS): one POST to servers.mjs's control port (SERVERS_CONTROL from
// run.mjs: 4549 unless --servers-control says otherwise), which restarts the workspaces on their
// own databases with their clock ${AHEAD} days ahead (0: the real one).
var response = http.post('http://localhost:' + SERVERS_CONTROL + '/restart?ahead=' + AHEAD, { body: '' });
if (response.status !== 200) {
    throw new Error('servers.mjs restart answered ' + response.status);
}
