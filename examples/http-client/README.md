# HTTP client

Three requests against [httpbingo](https://httpbingo.org) through `silk.http.client`: a GET with
query parameters, a POST with a JSON body, and a GET that answers 404. The program is written
against the `Http` service, and `main` provides `NativeHttp`, which owns the sockets, TLS, clocks,
and the trust store (`SSL_CERT_FILE` or the platform bundle).

```sh
silk run                       # all three
silk run -- post               # one of get, post, status
silk run -- all http://127.0.0.1:8080
```

A 404 is an ordinary response. Call `run response.expectOk()`, or build the provider with
`NativeHttp.make().failOnStatus()`, to turn 4xx and 5xx statuses into an `HttpError` instead.
