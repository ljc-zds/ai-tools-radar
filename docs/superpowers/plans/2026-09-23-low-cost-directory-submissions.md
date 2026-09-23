# Low-Cost Directory Submissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a deterministic, whitelist-only HTTP submission path that avoids LLM and browser costs while preserving the outreach ledger, mail processing, and public-link verification.

**Architecture:** `direct_targets.json` declares a fixed request contract per directory. `direct_submit.py` validates the whitelist and product payload, obtains the existing atomic claim, sends one HTTPS request, then writes a guarded ledger result or a human task. It delegates verification to the existing mail sweeper and link verifier rather than duplicating either component.

**Tech Stack:** Python 3.13 standard library (`json`, `urllib.request`, `unittest`), existing `outreach/state.py`, JSONL ledger, existing shell smoke suite.

**Spec:** `docs/superpowers/specs/2026-09-23-low-cost-submission-design.md`

## Global Constraints

- Only explicit `direct_targets.json` records may be contacted.
- Whitelist records must use HTTPS, declare a same-owner endpoint, field mapping, response assertion, and rate limit.
- Never automate CAPTCHA, login, account creation, payment, terms acceptance, reciprocal links, browser fallback, or LLM fallback.
- Claim delivery before every outbound request; never release the claim automatically.
- A generic HTTP 200 is not success evidence.
- Write all state through `state.claim_delivery`, `state.upsert_submission`, and `state.human_task_add`.
- Never log API keys or full credential-bearing request bodies.

---

## File Structure

- Create: `outreach/direct_targets.json` — source-controlled empty whitelist with its data contract documented in the file.
- Create: `outreach/direct_submit.py` — parser, whitelist validator, payload builder, one-shot HTTPS executor, response classifier, and CLI.
- Create: `outreach/tests/test_direct_submit.py` — isolated unit and loopback HTTP integration coverage.
- Modify: `outreach/tests/smoke.sh` — runs the direct-submit test file under its existing temporary `OUTREACH_STATE_DIR`.
- Modify: `outreach/README.md` — documents setup, dry-run, explicit target execution, and the manual-only failure policy.

### Task 1: Whitelist Contract and Validation

**Files:**
- Create: `outreach/direct_targets.json`
- Create: `outreach/direct_submit.py`
- Test: `outreach/tests/test_direct_submit.py`

**Interfaces:**
- Produces `load_targets(path: str) -> dict[str, dict]`.
- Produces `validate_target(target_id: str, record: dict) -> dict`.
- `validate_target` returns a normalized record with `id`, `domain`, `endpoint`, `method`, `field_map`, `expected_status`, `response_contains`, `rate_limit_seconds`, and `link_rel_expected`.
- `load_targets` raises `ValueError` when any record lacks required fields or violates the global constraints.

- [ ] **Step 1: Write failing validation tests**

```python
def test_validate_target_rejects_non_https_and_cross_origin():
    with pytest.raises(ValueError, match="HTTPS"):
        direct_submit.validate_target("bad", {
            "domain": "example.com", "endpoint": "http://example.com/submit",
            "method": "POST", "field_map": {"name": "name"},
            "expected_status": [202], "response_contains": "queued",
            "rate_limit_seconds": 86400, "link_rel_expected": "nofollow",
        })

    with pytest.raises(ValueError, match="same-owner"):
        direct_submit.validate_target("bad", {
            "domain": "example.com", "endpoint": "https://other.example/submit",
            "method": "POST", "field_map": {"name": "name"},
            "expected_status": [202], "response_contains": "queued",
            "rate_limit_seconds": 86400, "link_rel_expected": "nofollow",
        })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd outreach && python3 -m unittest tests/test_direct_submit.py -v`

Expected: FAIL because `direct_submit` does not exist.

- [ ] **Step 3: Create the empty whitelist and validator**

```json
{
  "version": 1,
  "targets": []
}
```

```python
REQUIRED = {"id", "domain", "endpoint", "method", "field_map",
            "expected_status", "response_contains", "rate_limit_seconds",
            "link_rel_expected"}

def validate_target(target_id, record):
    missing = REQUIRED - set(record)
    if missing:
        raise ValueError(f"{target_id}: missing {sorted(missing)}")
    endpoint = urllib.parse.urlparse(record["endpoint"])
    if endpoint.scheme != "https":
        raise ValueError(f"{target_id}: HTTPS endpoint required")
    if not endpoint.hostname or not same_owner(endpoint.hostname, record["domain"]):
        raise ValueError(f"{target_id}: same-owner endpoint required")
    if record["method"] != "POST" or not record["field_map"]:
        raise ValueError(f"{target_id}: POST and non-empty field_map required")
    if not record["response_contains"].strip():
        raise ValueError(f"{target_id}: positive response assertion required")
    return {**record, "id": target_id}
```

- [ ] **Step 4: Run the validation tests**

Run: `cd outreach && python3 -m unittest tests/test_direct_submit.py -v`

Expected: PASS for malformed-record cases.

- [ ] **Step 5: Commit**

```bash
git add outreach/direct_targets.json outreach/direct_submit.py outreach/tests/test_direct_submit.py
git commit -m "feat: validate direct submission whitelist"
```

### Task 2: One-Shot Submission and Ledger Integration

**Files:**
- Modify: `outreach/direct_submit.py`
- Modify: `outreach/tests/test_direct_submit.py`

**Interfaces:**
- Produces `build_payload(target: dict, kit: dict) -> dict[str, str]` using only fields explicitly mapped by `target["field_map"]`.
- Produces `submit_target(target: dict, kit: dict, *, opener=urlopen) -> dict`.
- On a positive contract match, `submit_target` calls `state.upsert_submission(domain, "pending_review", source="direct_submit", reason_code="submitted")`.
- On every unsafe or non-contract outcome, `submit_target` calls `state.human_task_add` and returns `{"status": "manual", "reason": ...}`.

- [ ] **Step 1: Write failing loopback-server tests**

```python
class SubmitHandler(BaseHTTPRequestHandler):
    body = b'{"status":"queued"}'
    status = 202
    requests = 0
    def do_POST(self):
        type(self).requests += 1
        self.send_response(type(self).status)
        self.end_headers()
        self.wfile.write(type(self).body)

def test_submit_writes_pending_review_once(server, kit, target):
    result = direct_submit.submit_target(target, kit)
    assert result["status"] == "pending_review"
    assert state.current_status(target["domain"])["status"] == "pending_review"
    assert SubmitHandler.requests == 1

def test_mismatched_receipt_becomes_manual_without_retry(server, kit, target):
    SubmitHandler.body = b'{"status":"unknown"}'
    result = direct_submit.submit_target(target, kit)
    assert result == {"status": "manual", "reason": "response_assertion_failed"}
    assert SubmitHandler.requests == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd outreach && python3 -m unittest tests/test_direct_submit.py -v`

Expected: FAIL because `build_payload` and `submit_target` do not exist.

- [ ] **Step 3: Implement payload and request execution**

```python
def submit_target(target, kit, *, opener=urllib.request.urlopen):
    claim = state.claim_delivery(target["domain"], source="direct_submit")
    if not claim.get("claimed"):
        return {"status": "skipped", "reason": "already_claimed"}
    payload = build_payload(target, kit)
    request = urllib.request.Request(
        target["endpoint"],
        data=urllib.parse.urlencode(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with opener(request, timeout=20) as response:
            status, body = response.status, response.read(64_000).decode("utf-8", "replace")
    except Exception as exc:
        return queue_manual(target, "network_error", str(exc))
    if status not in target["expected_status"]:
        return queue_manual(target, "unexpected_status", str(status))
    if target["response_contains"] not in body:
        return queue_manual(target, "response_assertion_failed", body[:300])
    state.upsert_submission(target["domain"], "pending_review", source="direct_submit",
                            reason_code="submitted", evidence=f"direct receipt {status}")
    return {"status": "pending_review", "http_status": status}
```

- [ ] **Step 4: Add duplicate-claim coverage and run tests**

```python
def test_second_run_cannot_send_a_second_request(server, kit, target):
    direct_submit.submit_target(target, kit)
    result = direct_submit.submit_target(target, kit)
    assert result == {"status": "skipped", "reason": "already_claimed"}
    assert SubmitHandler.requests == 1
```

Run: `cd outreach && python3 -m unittest tests/test_direct_submit.py -v`

Expected: PASS; all success, bad receipt, and duplicate-claim cases pass.

- [ ] **Step 5: Commit**

```bash
git add outreach/direct_submit.py outreach/tests/test_direct_submit.py
git commit -m "feat: execute whitelisted direct submissions"
```

### Task 3: CLI, Smoke Coverage, and Operator Documentation

**Files:**
- Modify: `outreach/direct_submit.py`
- Modify: `outreach/tests/smoke.sh`
- Modify: `outreach/README.md`

**Interfaces:**
- CLI: `python3 direct_submit.py --target <id> --kit <path> [--dry-run]`.
- `--dry-run` validates the target and payload but does not claim, contact, or write a ledger record.
- The executor accepts one `--target` only; bulk orchestration is explicitly deferred until several contracts are verified.

- [ ] **Step 1: Write failing CLI tests**

```python
def test_dry_run_does_not_send_or_claim(tmp_path, monkeypatch):
    code = direct_submit.main([
        "--targets", str(tmp_path / "targets.json"),
        "--target", "fixture", "--kit", str(tmp_path / "kit.json"), "--dry-run",
    ])
    assert code == 0
    assert state.current_status("fixture.example") is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd outreach && python3 -m unittest tests/test_direct_submit.py -v`

Expected: FAIL because `main(argv)` has not implemented CLI parsing and dry-run.

- [ ] **Step 3: Implement explicit-target CLI and dry-run**

```python
parser.add_argument("--targets", default=str(HERE / "direct_targets.json"))
parser.add_argument("--target", required=True)
parser.add_argument("--kit", default=str(HERE / "kit.json"))
parser.add_argument("--dry-run", action="store_true")

if args.dry_run:
    print(json.dumps({"status": "validated", "target": target["id"], "payload": payload}))
    return 0
```

- [ ] **Step 4: Extend smoke coverage and document operation**

Add to `tests/smoke.sh` after Python key-path tests:

```bash
echo "── Direct submit ──"
python3 -m unittest tests/test_direct_submit.py -v || fail=1
```

Add a README section that documents: a whitelist entry must have an independently verified request contract; run `--dry-run` first; run exactly one `--target`; any manual status must be investigated rather than retried; the existing mail sweeper and verifier remain responsible for verification and link status.

- [ ] **Step 5: Run complete regression suite**

Run: `cd outreach && bash tests/smoke.sh`

Expected: all existing smoke groups plus direct-submit tests pass.

- [ ] **Step 6: Commit**

```bash
git add outreach/direct_submit.py outreach/tests/test_direct_submit.py outreach/tests/smoke.sh outreach/README.md
git commit -m "docs: document direct submission workflow"
```

## Self-Review

- Spec coverage: Tasks 1-2 implement the whitelist, HTTPS/same-owner checks, claim-before-request, positive response contract, manual stop path, and ledger reuse. Task 3 implements dry-run, operator documentation, and suite-level regression coverage. Existing mail and verification components remain unchanged and are explicitly reused.
- Placeholder scan: this plan contains no `TBD`, `TODO`, or deferred implementation placeholders; the deliberate empty initial whitelist is a safety constraint from the approved spec.
- Type consistency: `validate_target`, `build_payload`, `submit_target`, and `main` are defined once and used with matching argument and return shapes across tasks.
