// Maestro's JavaScript (GraalJS): reads chaos-proxy.mjs's request count
// (GET /requests on PROXY_CONTROL) and fails when the app sent more than
// MAX_SAVES page saves (PATCH) or more than MAX_READS reads of one page (GET)
// since the last POST /reset (page-offline-typing.yaml: two minutes of offline typing send at
// most two saves, and no page read, which only a 409 would ask for).
var response = http.get('http://localhost:' + PROXY_CONTROL + '/requests');
if (response.status !== 200) {
    throw new Error('chaos-proxy requests answered ' + response.status);
}
var counts = json(response.body);
var saves = counts['PATCH /api/spaces/:id/pages/:id'] || 0;
var reads = counts['GET /api/spaces/:id/pages/:id'] || 0;
output.requests = response.body;
if (saves < 1 || saves > Number(MAX_SAVES)) {
    throw new Error('The app sent ' + saves + ' page saves, not 1 to ' + MAX_SAVES + ': ' + response.body);
}
if (reads > Number(MAX_READS)) {
    throw new Error('The app read the page ' + reads + ' times, more than ' + MAX_READS + ': ' + response.body);
}
