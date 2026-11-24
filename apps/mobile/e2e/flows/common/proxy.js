// Maestro's JavaScript (GraalJS): one POST to chaos-proxy.mjs's control port
// (PROXY_CONTROL from run.mjs: 4459 unless --proxy-control says otherwise).
var response = http.post('http://localhost:' + PROXY_CONTROL + '/' + ACTION, { body: '' });
if (response.status !== 200) {
    throw new Error('chaos-proxy ' + ACTION + ' answered ' + response.status);
}
