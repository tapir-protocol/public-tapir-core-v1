# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). Do not open a public issue for security reports.

Include where possible:

- affected contract(s) and function(s),
- a description of the issue and its impact,
- reproduction steps or a proof-of-concept test.

We will acknowledge reports and keep you informed of remediation progress. Please give us reasonable time to remediate before any public disclosure.

## Scope

- Solidity contracts under `contracts/` (excluding `contracts/mock/`, which are test-only).
- The official deployed instances listed in the Deployments section of the README.

## Out of scope

- Test mocks and development tooling that never hold funds.
- Issues already documented in `docs/tapir_pool_lifecycle_risk_controls.md` or the audit reports in `docs/audits/`, unless you can show a new exploit path.

## Existing audit coverage

Audit reports and briefs live in `docs/audits/`.

Hashlock findings L-01 and Q-01 are recorded as *Acknowledged*: accepted rather than changed in
code, so both behaviours are present in this release. `resolvePtrw()` has no `ptrwResolved` entry
guard, and `sellAndUnsplit()` uses the router's absolute token balances rather than per-call balance
changes. Reports of these two are not new findings; a report showing a concrete exploit path beyond
what the audit describes is.

## Development dependencies

The release removes known high and moderate npm advisories. A remaining low-severity
upstream `elliptic` advisory has no published patch and is confined to transitive
legacy development dependencies. Its scope and handling are recorded in
[PUBLICATION_REVIEW.md](PUBLICATION_REVIEW.md). CI rejects moderate-or-higher findings;
production npm dependencies currently have no reported advisories.
