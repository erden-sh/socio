// Maestro's JavaScript (GraalJS): the newest sign-in code workspace ${LETTER} sent by ${CHANNEL}
// (email or telegram) to the SMTP sink or the fake Telegram (servers.mjs --codes; GET /web/outbox
// on SERVERS_CONTROL), into output.code. With BEFORE (a count from an earlier MODE=count run) it
// waits, asking again, until more than BEFORE have come. MODE=count puts how many there are in
// output.codes.
var url = 'http://localhost:' + SERVERS_CONTROL + '/web/outbox?letter=' + LETTER;
var sent = function () {
    var response = http.get(url);
    if (response.status !== 200) {
        throw new Error('GET /web/outbox answered ' + response.status + ': ' + response.body);
    }
    var box = json(response.body);
    var list = CHANNEL === 'email' ? box.mail : box.telegram;
    return list.filter(function (entry) {
        return entry.code;
    });
};
if (MODE === 'count') {
    output.codes = sent().length;
} else {
    var before = Number(BEFORE || 0);
    var codes = sent();
    for (var attempt = 0; attempt < 400 && codes.length <= before; attempt++) {
        codes = sent();
    }
    if (codes.length <= before) {
        throw new Error('No new code by ' + CHANNEL + ' (' + codes.length + ' sent).');
    }
    output.code = codes[codes.length - 1].code;
}
