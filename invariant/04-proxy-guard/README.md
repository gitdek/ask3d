# Proxy request guard

Written by Invariant for [#20](https://github.com/gitdek/ask3d/issues/20): Check that no other site can spend the key or change the library.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/20#issuecomment-6751923041). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/ProxyGuard.tla`](.invariant/specs/ProxyGuard.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The guard starts ready, decides one request, and returns to ready before deciding another. |
| `TypeOK` | invariant | The state is ready with no request, or holds one bounded request and its NextResponse.next() or HTTP 403 result. |
| `SafeMethodsPass` | invariant | GET, HEAD and OPTIONS pass regardless of their headers. |
| `UntrustedHostsRefused` | invariant | Every other method receives 403 unless Host names a local address or a hostname in ASK3D_ALLOWED_HOSTS. |
| `CrossSiteRefused` | invariant | Every other method receives 403 when a nonempty Sec-Fetch-Site is neither same-origin nor none. |
| `MismatchedOriginRefused` | invariant | Every other method receives 403 when a valid nonempty Origin has a URL host that differs from the raw Host header, including case and port. |
| `MalformedOriginRefused` | invariant | Every other method receives 403 when a nonempty Origin cannot be parsed as a URL. |
| `AcceptedRequestsPass` | invariant | A request passes when its Host is local or listed, Sec-Fetch-Site is absent, empty, same-origin or none, and Origin is absent, empty or has exactly the same URL host as Host. |
| `LocalCurlPasses` | witness | A POST to localhost:3000 with neither browser header can pass. |
| `RebindingRefused` | witness | A POST to evil.example:3000 can receive 403 even with same-origin Sec-Fetch-Site and its own Origin. |
| `SkipHostCheck` | bug | A faulty guard passes a request from an untrusted Host because its browser headers are acceptable. |
| `IgnoreCrossSite` | bug | A faulty guard passes a cross-site request to an allowed Host because its Origin matches. |

Checked within `AllowedHosts = {"app.example"}`, `FetchSites = {"", "same-origin", "none", "cross-site"}`, `Hosts = {"localhost:3000", "192.168.1.2:3000", "workstation.local:3000", "app.example:3000", "evil.example:3000", ""}`, `Methods = {"GET", "POST"}`, `Origins = {"", "own", "other", "not a URL"}`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/04-proxy-guard
```
