# Minimum gap to a safely connected account

Status: design assessment only. No server, real credential, persistence mechanism,
backend access grant or deployment is added by this document.

VeilSplice can construct requests and project responses, but **cannot yet offer a
safe real-key input and persistent storage workflow**. Its environment backend is
a demo adapter. The minimum remaining work is four linked pieces:

## 1. A user-controlled input path backed by a mature secret store

Choose one existing managed secret store or OS credential store appropriate to
the deployment. Use its official authenticated UI or supported secure-entry flow
so the user submits the key directly; never paste it into chat, a request template,
source code, command arguments or an agent-readable environment file. Do not build
a homemade encrypted file format or keep a second plaintext copy.

Required evidence: the user can create/update/delete the named secret, see its
storage destination and access scope, and no value enters agent transcripts,
logs, browser screenshots or repository artifacts. Any credential creation or
new persistent access needs the applicable explicit approval before it occurs.

## 2. One backend adapter with a fixed binding and least-privilege retrieval

Implement `SecretBackend.Resolve` using that provider's maintained SDK. Bind a
public alias to one operator-configured secret identifier; the caller cannot pick
arbitrary secret paths. Give only the isolated executor permission to retrieve
that secret. Prefer the provider's supported workload identity rather than a
second long-lived key embedded in the application.

The store supplies encryption at rest, persistence, versioning/rotation and
revocation. VeilSplice should not reimplement them. Add offline adapter-contract
and failure tests first. Then test revocation and store unavailability without
leaking backend errors or values. No backend beyond environment injection exists
in the current code.

## 3. A protected execution boundary for the fixed-policy wrapper

The current CLI accepts operator-controlled `-policy`. Letting an agent choose
that argument, read the process environment, alter the executable or call the
backend directly defeats the intended boundary. The new `veilsplice-finmind` entry
point fixes its policy and backend alias in code, accepts only bounded typed
input, distinguishes authenticated/anonymous
operations and pins TaiwanStockPrice. It closes the arbitrary-policy input path
for that entry point, but still must run under an independent identity.

The FinMind wrapper already fixes exact GET endpoints and enforces one 4-6 digit
stock ID, at most 31 inclusive calendar days, fixed response schemas and mandatory
authentication on its authenticated operations. Add caller authorization, request
quotas and secret-free audit events. A local process boundary or approved managed
job runner may suffice; an internet-facing server is not inherently required.
No new identity, system permission change, egress rule or deployment was created.

## 4. An explicitly approved end-to-end check with rollback

After the first three parts exist, obtain approval identifying the credential,
backend and the intended FinMind data and usage destinations. The user enters the
key directly through the secure path. Run one small authorized authenticated data
request and one authorized usage read; report projected data/status only. Verify
that secret rotation/revocation stops access and that failures do not expose it.
Do not automatically retry invalid-token or access-denied requests. Do not claim
successful account connection until these live checks actually pass.

## What does not close the gap

- Passing the current tests, a successful anonymous API response, or publishing
  the repository does not establish authenticated access or a safe secret store.
- An environment variable avoids hardcoding but does not isolate a key from a
  caller with the same runtime or shell access.
- Adding a password field to a new web form does not establish secure storage,
  session security, caller isolation or the required permission boundary.
- Output redaction does not make an overprivileged or attacker-controlled endpoint
  safe, and schema projection is not a universal guarantee against secret leakage.

The next smallest implementation decision is the actual backend and execution
identity. Choosing those is necessary before wiring storage or asking the user to
supply a real key. These fixtures deliberately do not force that choice.
