# Security status

This document describes the **Go CLI** threat model. The separate `web/` package
has a Sites/D1 trust boundary, owner/CSRF authorization and credential persistence.
Read [web security boundaries](web/README.md) and
[deployment prerequisites](web/MAINTENANCE.md) before handling web credentials.
Publishing either package does not establish a safe live deployment.

Experimental prototype. No external security audit or production readiness claim.
The only included secret backend is explicit environment-variable injection for
controlled demonstrations. This is not a vault and does not encrypt or persist
secrets. Go's standard HTTP/TLS/encoding libraries are used; no encryption or
credential-store implementation is invented here.

## Trust and ownership

A trusted operator owns the policy, binary, backend, runtime environment, DNS/TLS
trust configuration and deployment. The template caller may be less trusted only
when it cannot inspect or mutate those components. The authorized destination is
necessarily a recipient of the secret. Its administrators, logs and downstream
systems are outside this program's control.

This CLI does not provide process isolation, authentication, multi-tenancy,
authorization of business operations, audit storage, rate limits or a secure input
UI. In particular, `-policy` is trusted operator input: letting an untrusted
caller select or create that file defeats every endpoint and secret binding rule.
A fixed-policy wrapper must use a separate identity and deny the caller
policy, binary, environment and backend access. The optional FinMind wrapper
fixes its input policy in code, but no independent OS identity or deployment
boundary is supplied here.
Do not give a caller arbitrary shell access and then assume this tool hides
secrets from that same caller. Do not load real user credentials until an approved
input and backend path exists.

## Controls implemented

- Trusted per-target exact HTTPS endpoint, method and secret aliases.
- Allowed header/query/form names; body format restriction and structural encoding.
- No caller-controlled destination, URL credentials, ports other than 443,
  wildcard hosts, direct IP targets or automatic redirects.
- All resolved DNS IPs checked, mixed unsafe answers rejected, literal IP dialing
  with original-host TLS validation; no environment proxy settings.
- Conservative private/link-local/loopback/metadata and special-use IP rejection.
- Strict JSON decoding including duplicate rejection, nesting and size bounds.
- Constant errors; no request logging or raw error wrapping.
- No response headers; body discard by default; opt-in typed projection only.
- Direct/common-encoding secret echo rejection as a limited defense in depth.

## Remaining risks

1. **Environment and memory exposure:** environment variables and Go strings are
   not secure storage. Other same-user processes, crash dumps, debugging, swap,
   core dumps and host administrators can expose values. Go garbage collection
   and immutable strings prevent reliable zeroization guarantees.
2. **Response covert channels:** projection and echo detection cannot detect every
   encoding or inference. A malicious service can split or transform values, or
   use status and timing. Even status-only mode exposes numeric status/timing.
3. **API semantics:** allowed endpoints can have operations, nested callback URLs
   or output routing that leak data or cause unwanted side effects. JSON request
   bodies are not restricted to a provider-specific schema. Use only understood,
   narrowly scoped operations; add schemas before hostile-caller deployment.
4. **Routing:** public IP checks cannot detect all special routing or metadata
   endpoints. Private NAT, custom DNS64/NAT64, transparent proxies and compromised
   trust roots are deployment concerns. Use independent egress enforcement.
5. **Upstream logging:** keys in query parameters can appear in the provider's
   access logs. Headers and bodies may also be logged by upstream infrastructure.
6. **Availability:** bounds and deadlines reduce resource abuse but do not provide
   quotas or complete DoS protection. Multiple executions can exhaust resources.
7. **Supply chain and maintenance:** use supported Go releases and monitor their
   security advisories. The standard-library-only design removes third-party Go
   modules, but not compiler, OS, root-certificate or CI supply-chain risk.
8. **HTTP error ambiguity:** a timeout or response rejection can happen after the
   upstream performed an action. There are no automatic application-level retries;
   callers must not blindly retry state-changing operations.

## Reporting

Before publication, send a minimal reproduction to the repository owner through a
private channel. Do not include real keys, confidential policy files or raw request
logs. A repository security contact / private vulnerability-reporting channel must
be configured by its eventual owner. Do not open a public issue containing a live
credential or unpublished exploitation details.
