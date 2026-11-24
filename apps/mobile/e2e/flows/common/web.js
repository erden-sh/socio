// Maestro's JavaScript (GraalJS): Ada on the web, through servers.mjs's control port (SERVERS_CONTROL;
// servers.mjs --codes --dev-links): ${METHOD} ${ROUTE} on workspace ${LETTER} (A by default), its JSON
// answer in output.web. ROUTE is one of /web/pair, /web/confirm?digits=, /web/other, /web/erase
// (README, Getting in). DIGITS, when set, goes into ROUTE's query as the 6 digits the test typed,
// read off the screen with copyTextFrom (maestro.copiedText), spaces dropped; with WRONG=true the
// test types other digits instead (the shown number plus one), as someone guessing would.
var letter = typeof LETTER === 'undefined' || !LETTER ? 'A' : LETTER;
var query = 'letter=' + letter;
if (typeof DIGITS !== 'undefined' && DIGITS) {
    var digits = String(DIGITS).replace(/\D/g, '');
    if (typeof WRONG !== 'undefined' && WRONG === 'true') {
        digits = String((Number(digits) + 1) % 1000000);
        while (digits.length < 6) {
            digits = '0' + digits;
        }
    }
    query += '&digits=' + digits;
}
var url = 'http://localhost:' + SERVERS_CONTROL + ROUTE + (ROUTE.indexOf('?') === -1 ? '?' : '&') + query;
var response = METHOD === 'GET' ? http.get(url) : http.post(url, { body: '' });
if (response.status !== 200) {
    throw new Error(METHOD + ' ' + ROUTE + ' answered ' + response.status + ': ' + response.body);
}
output.web = json(response.body);
