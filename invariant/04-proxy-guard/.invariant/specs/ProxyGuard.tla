---- MODULE ProxyGuard ----
CONSTANTS Methods, Hosts, FetchSites, Origins, AllowedHosts
VARIABLES request, response

vars == <<request, response>>

\* Each decision is one call to proxy on a matched /api/ or /statue/ path.
\* Methods are normalized to uppercase, as in proxy.  "" represents an
\* absent header; empty Fetch-Site and Origin have the same behavior (F4).
\* AllowedHosts contains the trimmed, nonempty entries of ASK3D_ALLOWED_HOSTS.
\* The bounded Host values have no surrounding whitespace.
Requests == [method : Methods, host : Hosts, site : FetchSites, origin : Origins]

NoRequest == "no request"

\* This is hostnameOf's exact projection on the six requested Host values.
\* Extend this table and LocalHost together if the Host bounds are enlarged.
Hostname(host) ==
    CASE host = "" -> ""
      [] host = "localhost:3000" -> "localhost"
      [] host = "192.168.1.2:3000" -> "192.168.1.2"
      [] host = "workstation.local:3000" -> "workstation.local"
      [] host = "app.example:3000" -> "app.example"
      [] host = "evil.example:3000" -> "evil.example"

\* Exact LOCAL_HOSTNAME results within the bounds, using the chosen policy:
\* F1 accepts regex digit chunks without a 255 limit; F2 admits only [::1]
\* as local IPv6; F3 admits one word/hyphen label before .local; matching
\* ignores case.  Those extra edge inputs are outside the requested bounds.
LocalHost(host) ==
    Hostname(host) \in {"localhost", "192.168.1.2", "workstation.local"}

\* F6/F7: compare the extracted hostname case-sensitively, at every port;
\* an allowlist entry containing a port cannot match an extracted hostname.
AllowedHost(host) == LocalHost(host) \/ Hostname(host) \in AllowedHosts

SafeMethod(method) == method \in {"GET", "HEAD", "OPTIONS"}

GoodSite(site) == site \in {"", "same-origin", "none"}

\* Origin tags are driver inputs: "" omits Origin, "own" sends http://Host,
\* "other" sends http://other.example:3000, and "not a URL" is literal.
\* With absent Host, "own" uses the NextRequest URL http://localhost:3000.
\* These are the resulting URL.host strings for the exact bounded inputs.
OriginHost(r) ==
    CASE r.origin = "own" -> IF r.host = "" THEN "localhost:3000" ELSE r.host
      [] r.origin = "other" -> "other.example:3000"
      [] OTHER -> ""

\* F5: compare URL.host with the raw Host header, including case and port.
GoodOrigin(r) ==
    r.origin = "" \/ (r.origin # "not a URL" /\ OriginHost(r) = r.host)

ShouldPass(r) ==
    SafeMethod(r.method) \/ (AllowedHost(r.host) /\ GoodSite(r.site) /\ GoodOrigin(r))

TypeOK ==
    /\ response \in {"ready", "next", "403"}
    /\ IF response = "ready" THEN request = NoRequest ELSE request \in Requests

SafeMethodsPass ==
    IF response = "ready" THEN TRUE
    ELSE SafeMethod(request.method) => response = "next"

UntrustedHostsRefused ==
    IF response = "ready" THEN TRUE
    ELSE (~SafeMethod(request.method) /\ ~AllowedHost(request.host)) => response = "403"

CrossSiteRefused ==
    IF response = "ready" THEN TRUE
    ELSE (~SafeMethod(request.method) /\ ~GoodSite(request.site)) => response = "403"

MismatchedOriginRefused ==
    IF response = "ready" THEN TRUE
    ELSE (~SafeMethod(request.method) /\ request.origin \notin {"", "not a URL"}
          /\ OriginHost(request) # request.host) => response = "403"

MalformedOriginRefused ==
    IF response = "ready" THEN TRUE
    ELSE (~SafeMethod(request.method) /\ request.origin = "not a URL") => response = "403"

AcceptedRequestsPass ==
    IF response = "ready" THEN TRUE
    ELSE (AllowedHost(request.host) /\ GoodSite(request.site) /\ GoodOrigin(request)) => response = "next"

LocalCurlPasses ==
    IF response # "next" THEN FALSE
    ELSE /\ request.method = "POST"
         /\ request.host = "localhost:3000"
         /\ request.site = ""
         /\ request.origin = ""

RebindingRefused ==
    IF response # "403" THEN FALSE
    ELSE /\ request.method = "POST"
         /\ request.host = "evil.example:3000"
         /\ request.site = "same-origin"
         /\ request.origin = "own"

Init ==
    /\ request = NoRequest
    /\ response = "ready"

Decide(r) ==
    /\ response = "ready"
    /\ request' = r
    /\ response' = IF ShouldPass(r) THEN "next" ELSE "403"

Reset ==
    /\ response \in {"next", "403"}
    /\ request' = NoRequest
    /\ response' = "ready"

Next == (\E r \in Requests : Decide(r)) \/ Reset

\* A DNS-rebinding regression: trust browser headers without checking Host.
SkipHostCheck ==
    /\ response = "ready"
    /\ \E r \in Requests :
        /\ ~SafeMethod(r.method)
        /\ ~AllowedHost(r.host)
        /\ GoodSite(r.site)
        /\ GoodOrigin(r)
        /\ request' = r
        /\ response' = "next"

\* A browser-guard regression: let a matching Origin override Fetch-Site.
IgnoreCrossSite ==
    /\ response = "ready"
    /\ \E r \in Requests :
        /\ ~SafeMethod(r.method)
        /\ AllowedHost(r.host)
        /\ ~GoodSite(r.site)
        /\ r.origin = "own"
        /\ GoodOrigin(r)
        /\ request' = r
        /\ response' = "next"

Spec == Init /\ [][Next]_vars
====
