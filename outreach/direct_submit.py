#!/usr/bin/env python3
"""Load and validate the whitelist for deterministic direct submissions."""

from __future__ import annotations

import json
import re
import urllib.parse

from rootdomain import host_of, same_root


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

    headers = record["headers"]
    if not _string_mapping(headers):
        raise ValueError(f"{target_id}: headers must be a string mapping")

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
