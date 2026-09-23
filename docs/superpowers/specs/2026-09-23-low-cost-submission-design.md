# Low-Cost Directory Submission Design

## Goal

Add a deterministic submission path for pre-approved directory endpoints. It
uses direct HTTP requests instead of page-by-page LLM or browser control, then
reuses the existing mail and link-verification components.

## Scope

- Only routes defined in a local whitelist are eligible.
- Every whitelist record declares its endpoint, method, allowed payload fields,
  expected response, expected link attribute, and per-domain rate limit.
- The direct path does not solve CAPTCHA, create accounts, pay, accept terms,
  or fall back to a browser or LLM.
- A mismatch, login wall, CAPTCHA marker, payment prompt, redirect outside the
  approved origin, unexpected HTTP status, or failed response assertion stops
  that row and creates an actionable manual record.

## Components

`outreach/direct_targets.json`

The source-controlled whitelist. A record contains the directory domain,
submission URL, HTTP method, field mapping from `kit.json`, required headers,
expected status codes, a response assertion, and submission constraints. A
record with a placeholder, incomplete field mapping, or missing assertion is
invalid and cannot run.

`outreach/direct_submit.py`

The low-cost executor. It accepts an explicit target id or a bounded batch,
loads `kit.json`, validates the whitelist record, and sends one declared HTTP
request. It uses the existing `state.upsert_submission` and atomic delivery
claim before an outbound request. It never discovers fields dynamically and
never invokes an LLM.

Existing `state.py`, `mail_sweeper.py`, and `verify_link.mjs`

The executor writes results through the existing guarded ledger. Mail handling
continues to use the authorized Agent Mail account. A response that suggests
review or email verification remains `pending_review`; only `verify_link.mjs`
can promote a result to `success` after observing the published link.

## State Flow

1. Select only an explicit whitelist target.
2. Validate target schema, product payload, rate limit, and current ledger
   state.
3. Atomically claim delivery for the directory domain.
4. Send the declared request once.
5. Assert the response against the target's expected contract.
6. Record `pending_review`, `emailed`, or `delivery_ambiguous` through the
   guarded ledger. Any non-contract response is a manual outcome, never an
   automatic retry or browser fallback.
7. Process verification mail with `mail_sweeper.py`; verify public placement
   with `verify_link.mjs`.

## Safety Rules

- A claim is made before every outbound request and is never released by the
  executor.
- The whitelist can only use HTTPS endpoints on the declared domain or an
  explicitly declared same-owner submission host.
- No record may encode a paid route, reciprocal-link requirement, account
  creation, CAPTCHA workflow, or browser-only form.
- Response assertions are positive and specific; a generic 200 response is
  not evidence of submission.
- The executor logs no API keys or full request bodies containing credentials.

## Initial Rollout

The initial whitelist is empty. `10015.io` is intentionally excluded because
its submission flow is browser-rendered and its free listing is nofollow. The
first production record is added only after its public request contract is
independently inspected and a dry-run fixture exists.

## Tests

- Schema validation rejects incomplete, non-HTTPS, cross-origin, paid, or
  browser-only records.
- A mocked endpoint proves exact field mapping and successful response
  classification.
- A mismatched response is recorded as manual and produces no retry.
- Repeated runs prove the delivery claim permits one outbound request only.
- Existing outreach smoke tests continue to pass unchanged.
