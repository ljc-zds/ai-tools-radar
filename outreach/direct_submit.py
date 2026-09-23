#!/usr/bin/env python3
"""Load and validate the whitelist for deterministic direct submissions."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from rootdomain import host_of, same_root
import state


HERE = Path(__file__).resolve().parent
REQUIRED_FIELDS = {
    "domain",
    "endpoint",
    "method",
    "field_map",
    "headers",
    "expected_status",
    "response_contains",
    "rate_limit_seconds",
    "link_rel_expected",
}
ALLOWED_LINK_RELS = frozenset({"dofollow", "nofollow", "ugc", "sponsored"})
UNSAFE_WORKFLOWS = (
    "paid",
    "reciprocal_link",
    "account_creation",
    "captcha",
    "browser_only",
    "login",
    "payment",
    "terms_acceptance",
)
PLACEHOLDERS = frozenset({"todo", "tbd", "changeme", "placeholder"})
CREDENTIAL_TOKENS = frozenset(
    {"password", "passwd", "secret", "token", "key", "authorization", "auth", "cookie", "session"}
)
ALLOWED_HEADER_NAMES = frozenset(
    {"accept", "accept-language", "content-type", "user-agent", "x-requested-with"}
)
RESPONSE_WALLS = (
    (
        "login_wall",
        re.compile(
            r"\b(?:log[ -]?in|sign[ -]?in|unauthorized|oauth|auth(?:entication|orization) required)\b",
            re.I,
        ),
    ),
    ("captcha_required", re.compile(r"\b(?:captcha|recaptcha|hcaptcha|turnstile)\b", re.I)),
    ("payment_required", re.compile(r"\b(?:payment required|paid plan|upgrade (?:your )?plan|subscribe to submit)\b", re.I)),
    (
        "terms_acceptance_required",
        re.compile(r"\b(?:accept|agree to) (?:the )?(?:terms|terms and conditions)\b", re.I),
    ),
)


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _string_mapping(value: object) -> bool:
    return isinstance(value, dict) and all(
        _nonempty_string(key) and _nonempty_string(item)
        for key, item in value.items()
    )


def _has_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        normalized in PLACEHOLDERS
        or re.match(r"^(?:todo|tbd)\b", normalized) is not None
        or re.match(r"^your(?:[_ -])", normalized) is not None
        or re.match(r"^replace(?:[_ -]?me)\b", normalized) is not None
        or (normalized.startswith("${") and normalized.endswith("}"))
        or (normalized.startswith("{") and normalized.endswith("}"))
        or (normalized.startswith("<") and normalized.endswith(">"))
    )


def _has_credential_name(value: str) -> bool:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    tokens = {part.lower() for part in re.split(r"[^A-Za-z0-9]+", separated) if part}
    compact = re.sub(r"[^a-z0-9]", "", value.lower())
    return bool(tokens & CREDENTIAL_TOKENS) or compact in {"apikey", "authorization"}


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Return redirect responses to the caller without contacting their target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


DEFAULT_OPENER = urllib.request.build_opener(NoRedirectHandler())


def validate_target(target_id: str, record: dict) -> dict:
    """Validate and normalize one source-controlled whitelist record."""
    if not _nonempty_string(target_id):
        raise ValueError("target id must be a non-empty string")
    if not isinstance(record, dict):
        raise ValueError(f"{target_id}: target record must be an object")

    missing = REQUIRED_FIELDS - set(record)
    if missing:
        raise ValueError(f"{target_id}: missing required fields {sorted(missing)}")

    domain = host_of(record["domain"]) if _nonempty_string(record["domain"]) else ""
    if not domain:
        raise ValueError(f"{target_id}: non-empty domain required")

    endpoint_value = record["endpoint"]
    if not _nonempty_string(endpoint_value):
        raise ValueError(f"{target_id}: HTTPS endpoint required")
    endpoint = urllib.parse.urlparse(endpoint_value)
    if endpoint.scheme.lower() != "https":
        raise ValueError(f"{target_id}: HTTPS endpoint required")
    if endpoint.username is not None or endpoint.password is not None:
        raise ValueError(f"{target_id}: endpoint must not contain credentials")
    if not endpoint.hostname or not same_root(endpoint.hostname, domain):
        raise ValueError(f"{target_id}: same-owner endpoint required")

    method = record["method"].upper() if _nonempty_string(record["method"]) else ""
    if method != "POST":
        raise ValueError(f"{target_id}: POST method required")

    field_map = record["field_map"]
    if (
        not _string_mapping(field_map)
        or not field_map
        or any(_has_placeholder(key) or _has_placeholder(value) for key, value in field_map.items())
    ):
        raise ValueError(f"{target_id}: complete non-empty field_map required")
    if any(
        _has_credential_name(remote_field) or _has_credential_name(kit_path)
        for remote_field, kit_path in field_map.items()
    ):
        raise ValueError(f"{target_id}: credential-like field_map names are not allowed")

    headers = record["headers"]
    if not _string_mapping(headers):
        raise ValueError(f"{target_id}: headers must be a string mapping")
    unapproved_headers = [
        name for name in headers if name.strip().lower() not in ALLOWED_HEADER_NAMES
    ]
    if unapproved_headers:
        raise ValueError(
            f"{target_id}: allowed header names are {sorted(ALLOWED_HEADER_NAMES)}"
        )

    statuses = record["expected_status"]
    if (
        not isinstance(statuses, list)
        or not statuses
        or any(type(status) is not int or not 100 <= status <= 599 for status in statuses)
    ):
        raise ValueError(f"{target_id}: expected_status must contain HTTP status integers")

    response_contains = record["response_contains"]
    if not _nonempty_string(response_contains):
        raise ValueError(f"{target_id}: positive response assertion required")

    rate_limit = record["rate_limit_seconds"]
    if type(rate_limit) not in (int, float) or rate_limit <= 0:
        raise ValueError(f"{target_id}: positive rate_limit_seconds required")

    link_rel = record["link_rel_expected"]
    if link_rel not in ALLOWED_LINK_RELS:
        raise ValueError(
            f"{target_id}: link_rel_expected must be one of {sorted(ALLOWED_LINK_RELS)}"
        )

    constraints = record.get("constraints", {})
    if not isinstance(constraints, dict):
        raise ValueError(f"{target_id}: constraints must be an object")
    for workflow in UNSAFE_WORKFLOWS:
        if record.get(workflow) or constraints.get(workflow):
            raise ValueError(f"{target_id}: {workflow} workflows are not allowed")

    return {
        **record,
        "id": target_id.strip(),
        "domain": domain,
        "endpoint": endpoint.geturl(),
        "method": method,
        "field_map": {key.strip(): value.strip() for key, value in field_map.items()},
        "headers": {key.strip(): value.strip() for key, value in headers.items()},
        "expected_status": list(statuses),
        "response_contains": response_contains.strip(),
        "rate_limit_seconds": rate_limit,
        "link_rel_expected": link_rel,
    }


def load_targets(path: str) -> dict[str, dict]:
    """Load, validate, and index a version-one target whitelist."""
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)

    if not isinstance(document, dict) or document.get("version") != 1:
        raise ValueError("target whitelist must be a version 1 object")
    records = document.get("targets")
    if not isinstance(records, list):
        raise ValueError("target whitelist targets must be a list")

    targets = {}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"target at index {index} must be an object")
        target_id = record.get("id")
        if not _nonempty_string(target_id):
            raise ValueError(f"target at index {index} has an invalid id")
        target_id = target_id.strip()
        if target_id in targets:
            raise ValueError(f"duplicate target id: {target_id}")
        target_record = {key: value for key, value in record.items() if key != "id"}
        targets[target_id] = validate_target(target_id, target_record)
    return targets


def build_payload(target: dict, kit: dict) -> dict[str, str]:
    """Resolve only explicitly declared dotted kit paths into form fields."""
    payload = {}
    for remote_field, dotted_path in target["field_map"].items():
        value = kit
        parts = dotted_path.split(".")
        if not all(parts):
            raise ValueError(f"field_map path is invalid: {dotted_path!r}")
        for part in parts:
            if not isinstance(value, dict) or part not in value:
                raise ValueError(f"field_map path is missing: {dotted_path}")
            value = value[part]
        if value is None or isinstance(value, (dict, list, tuple, set)):
            raise ValueError(f"field_map path must resolve to a scalar: {dotted_path}")
        payload[remote_field] = str(value)
    return payload


def _queue_manual(target: dict, reason: str) -> dict:
    state.human_task_add(
        target["domain"],
        url=target.get("endpoint", ""),
        blocker=reason,
        guidance=f"Inspect the direct submission outcome ({reason}) and resolve manually.",
    )
    return {"status": "manual", "reason": reason}


def _response_values(response):
    with response:
        status = getattr(response, "status", None)
        if status is None and hasattr(response, "getcode"):
            status = response.getcode()
        body = response.read(64_000).decode("utf-8", "replace")
        final_url = response.geturl() if hasattr(response, "geturl") else None
    return status, body, final_url


def _response_wall(body: str):
    for reason, pattern in RESPONSE_WALLS:
        if pattern.search(body):
            return reason
    return None


def submit_target(target: dict, kit: dict, *, opener=DEFAULT_OPENER.open) -> dict:
    """Claim and execute exactly one declared direct-submission request."""
    if not isinstance(target, dict) or not _nonempty_string(target.get("id")):
        raise ValueError("validated target with a non-empty id required")
    target = validate_target(
        target["id"], {key: value for key, value in target.items() if key != "id"}
    )

    try:
        claim = state.claim_delivery(target["domain"], source="direct_submit")
    except Exception:
        return _queue_manual(target, "claim_error")
    if not claim.get("claimed"):
        return {"status": "skipped", "reason": "already_claimed"}

    try:
        payload = build_payload(target, kit)
    except (KeyError, TypeError, ValueError):
        return _queue_manual(target, "payload_contract_error")

    headers = {**target.get("headers", {}), "Content-Type": "application/x-www-form-urlencoded"}
    request = urllib.request.Request(
        target["endpoint"],
        data=urllib.parse.urlencode(payload).encode("ascii"),
        method="POST",
        headers=headers,
    )
    try:
        try:
            response = opener(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        status, body, final_url = _response_values(response)
    except Exception:
        return _queue_manual(target, "network_error")

    if not _nonempty_string(final_url):
        return _queue_manual(target, "unsafe_response_url")
    parsed = urllib.parse.urlparse(final_url)
    if parsed.scheme.lower() != "https" or not parsed.hostname or not same_root(
        parsed.hostname, target["domain"]
    ):
        return _queue_manual(target, "unsafe_response_url")

    if isinstance(status, int) and 300 <= status <= 399:
        return _queue_manual(target, "redirect_response")
    if status in {401, 403, 407}:
        return _queue_manual(target, "login_wall")
    if status == 402:
        return _queue_manual(target, "payment_required")
    wall = _response_wall(body)
    if wall:
        return _queue_manual(target, wall)
    if status not in target["expected_status"]:
        return _queue_manual(target, "unexpected_status")
    if target["response_contains"] not in body:
        return _queue_manual(target, "response_assertion_failed")

    try:
        written = state.upsert_submission(
            target["domain"],
            "pending_review",
            source="direct_submit",
            reason_code="submitted",
            evidence=f"direct receipt {status}",
        )
    except Exception:
        return _queue_manual(target, "ledger_write_error")
    if not written.get("written"):
        return _queue_manual(target, "ledger_write_error")
    return {"status": "pending_review", "http_status": status}


def _load_json(path: str):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Submit one reviewed direct target.")
    parser.add_argument("--targets", default=str(HERE / "direct_targets.json"))
    parser.add_argument("--target", required=True, action="append")
    parser.add_argument("--kit", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if len(args.target) != 1:
        print("direct-submit error: exactly one --target is required", file=sys.stderr)
        return 2
    target_id = args.target[0]

    try:
        targets = load_targets(args.targets)
        if target_id not in targets:
            raise ValueError(f"unknown target: {target_id}")
        target = targets[target_id]
        kit = _load_json(args.kit)
        if not isinstance(kit, dict):
            raise ValueError("kit must be a JSON object")
        payload = build_payload(target, kit)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"direct-submit error: {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        result = {"status": "validated", "target": target["id"], "payload": payload}
    else:
        result = submit_target(target, kit)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
