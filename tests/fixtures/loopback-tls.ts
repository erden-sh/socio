// Testing only (CB-222): a self-signed leaf certificate (CA:FALSE, server
// auth only) and its key for 127.0.0.1 and localhost, valid until 2126, for
// the fake realtime server's wss path. Made with openssl for these tests
// alone; it guards nothing. Node can't make a certificate itself; kept
// here so tests need no openssl. Not in images (.dockerignore).
export const LOOPBACK_TLS = {
    key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgdxgIIQcdhlRJUZH+
VxJMzC4PPDMvu7R7qrzB1boH0nOhRANCAARcC0ukoyWFF9lZbRIJm/sqYYS6imDv
ygwVcSQzHlR2Nq+Lw/LjGXt24zHWyDtT/lxXa+7zyQvcwq8sPMV2yviD
-----END PRIVATE KEY-----`,
    cert: `-----BEGIN CERTIFICATE-----
MIIBvzCCAWWgAwIBAgIUGgiJdlmqtHIGXTe0pbKcT2yh4iIwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMzA0NTIwM1oYDzIxMjYwOTI5
MDQ1MjAzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARcC0ukoyWFF9lZbRIJm/sqYYS6imDvygwVcSQzHlR2Nq+Lw/LjGXt2
4zHWyDtT/lxXa+7zyQvcwq8sPMV2yviDo4GSMIGPMB0GA1UdDgQWBBSOdTLWzZBA
vEBdJ2f5LRyiRT/2wjAfBgNVHSMEGDAWgBSOdTLWzZBAvEBdJ2f5LRyiRT/2wjAa
BgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TAQH/BAIwADAOBgNVHQ8B
Af8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0EAwIDSAAwRQIh
AOPu9CdIB7Ivi5Y/yUhurUzjcL9SZgZ9rNA0w1PytURGAiBid7Ehb1At3zwErtGH
fWGrR4ZvI2K1Cnp72uczA9pUbg==
-----END CERTIFICATE-----`,
};
