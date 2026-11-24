// The one script every link page runs, as text: the Worker serves exactly this string
// inline, allowed by its SHA-256 in the page's Content-Security-Policy, and tests/page-script.test.ts
// runs the same string against a stand-in page.
//
// It is the only thing that reads the fragment, which holds the link's code or token and which no
// request carries. It reads it, checks it the way @socio/shared's parseAppLink does (the same keys,
// no repeats or empty values, the workspace host by isLinkHost's pattern, and no port on production
// paths), and then only fills in what the page shows, or `#invalid` when the link isn't whole:
//
// - on `c`, the sign-in code, in groups of four;
// - on `i`, the "Continue" button's href, `https://<host>/reset-password?token=<t>`: the invite
//   goes to the workspace only when the person taps it, never by itself, on any path.
//
// No page links back to itself (iOS keeps a same-host link in Safari), and nothing here builds a
// custom-scheme URL: a scheme isn't verified, so the fragment never goes into one.
//
// It makes no request, opens nothing, sets no location and writes no markup: textContent, href and
// hidden only. The page's data (`#link-data`, JSON the Worker wrote from the path) gives the kind,
// the fragment's keys, the host from the path and the code's alphabet.
export const PAGE_SCRIPT = `(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('link-data').textContent);
  var HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\\d{1,5})?$/;
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };
  var okHost = function (host) {
    return host.length <= 260 && HOST.test(host) && !(data.noPort && host.indexOf(':') >= 0);
  };
  var readFragment = function (hash) {
    var text = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    var fields = {};
    var count = 0;
    if (text) {
      var parts = text.split('&');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq <= 0) { return null; }
        var key = parts[i].slice(0, eq);
        var value;
        try { value = decodeURIComponent(parts[i].slice(eq + 1)); } catch (error) { return null; }
        if (own(fields, key) || !value) { return null; }
        fields[key] = value;
        count++;
      }
    }
    if (count !== data.keys.length) { return null; }
    for (var k = 0; k < data.keys.length; k++) {
      if (!own(fields, data.keys[k])) { return null; }
    }
    if (own(fields, 'ws') && !okHost(fields.ws)) { return null; }
    return fields;
  };
  var readCode = function (input) {
    var code = input.replace(/[\\s-]/g, '').toUpperCase();
    if (code.length !== data.codeLength) { return null; }
    for (var i = 0; i < code.length; i++) {
      if (data.codeAlphabet.indexOf(code.charAt(i)) < 0) { return null; }
    }
    return code.match(/.{1,4}/g).join('-');
  };
  var show = function (id) { var element = document.getElementById(id); element.hidden = false; return element; };
  var fields = readFragment(location.hash);
  var code = fields && data.kind === 'c' ? readCode(fields.code) : null;
  if (!fields || (data.kind === 'c' && !code)) {
    show('invalid');
    return;
  }
  if (code) {
    show('code').textContent = code;
  }
  if (data.kind === 'i') {
    show('continue').href = 'https://' + data.host + '/reset-password?token=' + encodeURIComponent(fields.t);
  }
})();
`;
