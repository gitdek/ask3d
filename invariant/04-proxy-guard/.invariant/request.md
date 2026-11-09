# Check that no other site can spend the key or change the library

Issue #20 in gitdek/ask3d, opened by @gitdek.

Code: proxy.ts

`proxy` in `proxy.ts` guards every request to `/api/` and `/statue/`, the ones that can spend the API key, change the library or start a statue. Check it as it is, without changing a line, against these rules:

- GET, HEAD and OPTIONS always pass.
- Any other request passes only if its `Host` names a local address (localhost, a loopback or private address, or a `.local` name) or a host listed in `ASK3D_ALLOWED_HOSTS`. Every other host is refused with 403, whatever else the request carries.
- A browser request that another site started is refused with 403: a `Sec-Fetch-Site` other than `same-origin` or `none`, an `Origin` whose host and port differ from the request's `Host`, or an `Origin` that isn't a URL.
- A request to a local host with neither header, as curl sends it, passes.

The driver builds `NextRequest`s from each combination of method, host, `Sec-Fetch-Site` and `Origin` within the bounds, and reads the response: `NextResponse.next()` passes it on, and 403 refuses it.

## Discussion

**@gitdek:**

Check `proxy` as it is, against the issue's rules, with no alternatives to choose from. The last draft found seven edge cases; take what the code does today for each, option A in every one:

- F1: an IPv4-looking host matching the regex counts as local even with an octet above 255.
- F2: only `[::1]` counts as local IPv6.
- F3: a `.local` name counts only with one label before `.local`.
- F4: an empty `Sec-Fetch-Site` or `Origin` counts as absent.
- F5: the Origin's host must equal the `Host` header exactly, case and port included.
- F6 and F7: allowlist entries are hostnames, matched case-sensitively, that allow every port; an entry with a port matches nothing.

None of these lets another site in: each is stricter than it needs to be, or needs a value a browser never sends.

Keep it small enough for one comment: about a dozen statements, and bounds of a few values each. Methods GET and POST; hosts `localhost:3000`, `192.168.1.2:3000`, `workstation.local:3000`, `app.example:3000` (listed in `ASK3D_ALLOWED_HOSTS`), `evil.example:3000` and none; `Sec-Fetch-Site` absent, `same-origin`, `none` and `cross-site`; `Origin` absent, the request's own, another site's and `not a URL`.

**@gitdek:**

The last draft was right in substance (12 statements, three named states, no alternatives) but still too big to publish: its model let any request follow any other, so the chart's six arrows carried 36,864 concrete steps, about 3.4 MB of evidence.

Decide each request from the ready state only, and go back to ready before the next one, with a step back to ready or one request per run. Then each request adds one step out of ready and one back, a few hundred in all. Keep everything else from the last draft: the same statements, view and bounds.
