# Security review — 7 September 2026

Baseline: `240de15`, plus the security changes in this working tree. Earlier
September 3–4 audit notes were checked against the current implementation;
they are historical evidence, not proof that a finding is still present.
Pre-existing workspace edits were preserved.

## Result and scope

The confirmed critical and high-priority application paths identified below
have fixes and regression coverage. Deployment must apply the new migrations,
images and proxy configuration before those fixes protect a running instance.
This review did not access the production host, change live data, rotate live
credentials, inspect provider billing settings, or verify backups.

Reviewed: public/authenticated HTTP routes; bearer and invite lifecycles;
room/participant authorization; commands and confirmations; HTTP/WebSocket
privacy projections; model tools and private-condition handling; outbound
HTTP, redirects and DNS; browser rendering, links, CSP and caching; package
advisories; migrations; Docker/Compose configuration; logging and tracked
credential patterns. Tests used an isolated local PostgreSQL database and
scripted model responses, with no paid model calls.

## Findings and disposition

IDs retain the earlier audit's numbering for traceability. Severity below is
the pre-fix assessment of the current code, not an assertion of exploitation.

| ID | Priority | Finding and disposition |
|---|---|---|
| SEC-01 | Critical | **Fixed:** guest confirmations were global and unrelated organizers could replace/delete them. Confirmation uniqueness, reads, writes, deletes and candidate revision notifications now include the originating room. Existing rows stay in their original room; rows with no room are not projected. Cross-room overwrite/removal regressions pass. |
| SEC-02 | High | **Mitigated with an enforced action boundary:** built-in model tool calls now create a private proposal, without executing the command. Only the owner's page receives its random approval identifier and exact proposed values. Approval consumes it once, within five minutes, and submits the stored arguments at the original revision through ordinary authorization and consent checks. Private-condition text is no longer supplied to this tool-calling model; the separate tool-less screening path retains it. See residual model limits below. |
| SEC-03 | High | **Fixed in configuration/code:** HTTP and WebSocket client addresses use an explicit proxy IP/CIDR trust list. Production Compose requires that configuration. Bounded rate-limit maps refuse new keys when full rather than discarding an exhausted active quota. IP limits are supplemented by global, participant and room limits. Forwarded-header spoofing and proxy trust are tested. |
| SEC-04 | Conditional Medium | **Fixed:** production CSP blocks framing, scripts from other origins, plugins and injected base URLs; X-Frame-Options is DENY. HTTPS deployments emit HSTS for the app host only. Added nosniff, no-referrer, restricted browser permissions and private-response cache controls. No reliance on cross-site storage partitioning or a particular browser's iframe behavior. |
| SEC-05 | High advisory; conditional reachability | **Patched:** upgraded `@fastify/static` to 10.1.2 or later and refreshed the lockfile. Both full and production package audits report zero advisories. Compose now selects PostgreSQL 17.11 and Caddy 2.11.4. The app served public files without the advisory's affected guard/listing configuration, so the package rating does not establish a working app exploit. Container rollout remains outstanding. |
| SEC-06 | High | **Mitigated:** WebSocket limits cover frame size, origins, handshakes, simultaneous connections, in-flight messages, send buffers and lifetime. Added HTTP concurrency and body limits, process-wide model/outbound attempt and concurrency budgets, and model output caps. Durable room limits bound participants, requirements and proposals. Production app containers have memory/CPU/PID limits. Large-scale traffic still needs edge protection. |
| SEC-07 | Medium | **Partially fixed:** participant tokens expire after 24 hours; legacy organizer recovery secrets after seven days. New join links already have a one-hour initial claim window and browser-secret binding. Claimed-link recovery still has no final lifetime or self-service revocation; see follow-up work. |
| SEC-08 | Medium | **Direct-transport gap fixed:** Undici now validates the DNS answers handed to its socket, not just a separate earlier lookup. Internal, mapped and transition addresses are rejected. Cross-origin redirects drop Authorization, Cookie and Proxy-Authorization. An external forward proxy still controls its own target resolution; that boundary needs egress controls. |
| SEC-09 | Medium | **Partially fixed:** application images run as the Node user. Production app containers drop Linux capabilities and disallow privilege escalation; production Compose no longer supplies a default database password. The runtime database role still shares migration/administrative privileges. |
| SEC-10 | Medium | **Fixed for production:** outbound diagnostics return 404 to ordinary participant tokens in production. Development retains diagnostics for debugging. |
| SEC-11 | Low hardening | **Fixed:** production Vite builds no longer emit source maps. The source is public, so this was not evidence of secret disclosure. |
| SEC-12 | Medium operational risk | **Unverified:** production restore tests, monitoring, host patching, provider account ceilings and incident response require operator verification. No production access was used. |
| SEC-13 | High | **Fixed legacy impersonation path:** public room creation no longer provisions members with creator-known credentials; they join using browser-bound claims. Legacy member exchanges are disabled. Migration 027 revokes the tokens issued to those old member identities. An explicit fixture switch works only outside production. First-claim identity assurance remains limited by guest access. |

## Important implementation details

The confirmation fix is a database and authorization change, not just a tool
catalog change: calling `/api/commands` directly cannot affect another room's
confirmation. Migration 026 changes the key to
`(room_id, osm_ref, criterion_id)`. Tests cover two rooms holding the same place,
independent writes, forbidden foreign deletion, and unchanged foreign reads.

Model approval IDs are 256-bit random values, bound to the participant and an
immutable stored command. They are absent from model/tool results, public
syncs, and peer projections. Extra arguments supplied to the approval endpoint
are ignored. Expired, consumed, foreign, and stale-revision approvals fail.
The review card uses escaped text and shows the proposed fields. This follows
OWASP's recommendation to combine limited tool authority with human review
for consequential actions; prompt instructions alone are not a security
boundary. [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

Default resource ceilings, per application process:

| Boundary | Default |
|---|---|
| API body / concurrent requests | 64 KiB / 128 |
| General API requests | 600/IP/minute; 6,000 total/minute |
| Room creation and plan preview | 50/IP/hour; 100 total/hour, combined |
| Invite exchange, public claims, invite management | Separate 30/IP/minute buckets; 300 total/minute |
| Natural-language routes | 20/participant/minute; 60/room/minute; 1 concurrent/participant, 2/room, 6 total |
| Actual model attempts, including retries/background work | 600/hour; 2,000/day; 6 concurrent; at most 8,000 output tokens/attempt |
| Outbound attempts, including retries and redirect hops | 5,000/hour; 20,000/day; 24 concurrent |
| WebSocket | 4 KiB frames; 60 handshakes/IP/minute; 64 connections/IP, 4/participant, 24/room, 256 total |
| WebSocket messages and output | 100 frames/10 seconds/socket; 2 handlers/socket; disconnect above 1 MiB buffered output; reconnect after 15 minutes |
| Durable room size | 24 participants; 32 requirements/participant and 128/room, including withdrawn history; 64 proposals/room |

Limits deliberately refuse excess work instead of accumulating an unlimited
queue. Quotas protect resource use but do not guarantee availability against a
distributed attacker. They are process-local and restart with the process;
multiple replicas need shared quotas. Attempt/output limits are not dollar
ceilings: configure provider account spending limits too.
[OWASP denial-of-service guidance](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)

The package patches follow the maintainer's
[path traversal advisory](https://github.com/fastify/fastify-static/security/advisories/GHSA-83w8-p2f5-377r)
and [canonical-path advisory](https://github.com/fastify/fastify-static/security/advisories/GHSA-8pvw-jcv7-9cmj).
Container versions were checked against the
[PostgreSQL security list](https://www.postgresql.org/support/security/17/)
and [Caddy 2.11.4 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4).

## Remaining work

- Separate the application's database role from the migration/bootstrap role;
  grant only required table/sequence privileges. Confirm backup encryption,
  retention and a successful restore before changing live database images.
- Add invite/session revocation, a bounded recovery lifetime and automated
  retention for rooms, tokens, events and caches. A stolen claimed join link
  plus its browser secret can still mint fresh tokens. Browser binding proves
  possession, not the real-world identity of the intended invite recipient;
  account authentication or an independent invitation channel is needed for
  that stronger claim.
- Apply network egress restrictions to both the app and any forwarding proxy.
  The direct socket lookup fix cannot control a third-party proxy's resolver.
- Enforce persistent spending/traffic ceilings outside the process, with alerts
  and edge abuse protection. Public guest room creation remains available.
- Maintain dependency/container scans and patch/restore procedures. Images
  still use version tags rather than immutable digests; host state is unknown.

Model residuals: untrusted prose can still influence suggestions, answers and
tool-less need interpretation. A participant can approve a bad suggestion.
Ordinary composer need parsing and owner-authorized private screening still
operate as before. External WebMCP agents retain the documented authority of
their participant; the new review step is for the application's built-in
tool-calling model. Anyone who compromises the page's origin or steals its
bearer credential can act as that participant. Application-private data remains
visible to the operator. None of these controls certifies a human's intent
cryptographically.

## Rollout and verification

1. Set `APP_URL` to the exact HTTPS origin, a strong `POSTGRES_PASSWORD`, and
   `TRUSTED_PROXIES` to the real proxy addresses/CIDRs. Trust only the proxy
   network; it must overwrite client-supplied forwarding headers. Do not use
   `true`, a hop count, or a subnet shared with untrusted workloads. Confirm
   client IPs on the deployed topology before relying on quotas.
2. Back up the database, deploy the patched images, and run migrations
   026–028. Migration 027 intentionally logs out legacy members because the
   creator could have minted any of their tokens. Invite those people again
   with the new claim flow; old production demo member URLs no longer work.
   Local demo fixtures remain available through development Compose.
3. Check headers, real client-IP attribution, join/rejoin, approval, ordinary
   room flows, WebSocket reconnects, and provider limits after deployment.

Validation passed: 786 unit tests, 260 API tests, and seven Chromium tests
covering desktop/mobile approval, onboarding and three-user flows. Coverage
includes adversarial authorization, DNS and transport cases. Typechecking,
the production build, production Compose configuration parsing and
`git diff --check` passed; full and production dependency audits each reported
zero vulnerabilities. The isolated database used PostgreSQL 18.4 binaries; the
PostgreSQL 17.11 production image and Docker build were not run because this
workspace has no Docker daemon. No real model/provider prompt-injection
benchmark was performed. The tracked-file scan found no matches for the
common private-key/token patterns checked; it was not an exhaustive secret or
Git-history scan.

The follow-up design-hook review removed the error alert's amber side border
(amber denotes unverified data, not failure) and aligned flagged general
component sizes/radii with existing tokens. Four value-specific, stylesheet-
scoped detector exceptions preserve documented 7px map attribution, the 9px
drawer control, 7px scope-chip corners, and the small rectangular geometry of
the location-sharing mark and attribution plates. These exceptions were
recorded through `hook-admin.mjs` with their evidence; no whole-rule or
whole-file ignores were added. The approval UI was checked at desktop and
mobile widths.
