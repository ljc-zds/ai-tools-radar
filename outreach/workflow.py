#!/usr/bin/env python3
"""Deterministic opportunity -> review -> approval workflow.

This module deliberately stops before network submission. It turns reviewed
contracts into the existing direct-submit whitelist and prints the next
mail/verification commands for an operator to run separately.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import direct_submit


HERE = Path(__file__).resolve().parent
DEFAULT_OPPORTUNITIES = HERE / "opportunities.json"
DEFAULT_TARGETS = HERE / "direct_targets.json"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _read(path: str | Path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _write(path: str | Path, value) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp.replace(target)


def load_opportunities(path: str | Path) -> list[dict]:
    document = _read(path)
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ValueError("opportunities must be a version 1 object")
    rows = document.get("opportunities")
    if not isinstance(rows, list):
        raise ValueError("opportunities must contain a list")
    ids = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
            raise ValueError("each opportunity needs a non-empty id")
        if row["id"] in ids:
            raise ValueError(f"duplicate opportunity id: {row['id']}")
        ids.add(row["id"])
        status = row.get("status", "candidate")
        if status not in {"candidate", "needs_contract", "qualified", "approved", "manual"}:
            raise ValueError(f"{row['id']}: invalid opportunity status")
        if "status" not in row:
            row["status"] = "candidate"
    return rows


def discover(input_path: str | Path, output_path: str | Path) -> dict:
    """Normalize externally discovered candidates without qualifying them."""
    raw = _read(input_path)
    if not isinstance(raw, list):
        raise ValueError("discovery input must be a JSON list")
    rows = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError("each discovered item needs an id")
        item_id = item["id"].strip()
        if not item_id or item_id in seen:
            raise ValueError(f"duplicate or empty discovery id: {item_id}")
        if not isinstance(item.get("domain"), str) or not item["domain"].strip():
            raise ValueError(f"{item_id}: domain is required")
        seen.add(item_id)
        rows.append({**item, "id": item_id, "status": "candidate", "discovered_at": _now()})
    result = {"version": 1, "opportunities": rows}
    _write(output_path, result)
    return result


def review(opportunities_path: str | Path, output_path: str | Path) -> dict:
    """Qualify only records carrying a complete, safe direct contract."""
    rows = load_opportunities(opportunities_path)
    reviewed = []
    for row in rows:
        contract = row.get("contract")
        updated = dict(row)
        if not isinstance(contract, dict):
            updated["status"] = "needs_contract"
            updated["review_reason"] = "independently_verified_contract_required"
        else:
            try:
                normalized = direct_submit.validate_target(row["id"], contract)
            except (TypeError, ValueError) as exc:
                updated["status"] = "manual"
                updated["review_reason"] = str(exc)
            else:
                updated["status"] = "qualified"
                updated["reviewed_at"] = _now()
                updated["contract"] = normalized
        reviewed.append(updated)
    result = {"version": 1, "opportunities": reviewed}
    _write(output_path, result)
    return result


def approve(opportunities_path: str | Path, target_id: str, targets_path: str | Path) -> dict:
    """Copy one qualified contract into the source-controlled whitelist."""
    rows = load_opportunities(opportunities_path)
    selected = next((row for row in rows if row["id"] == target_id), None)
    if not selected or selected.get("status") != "qualified":
        raise ValueError(f"{target_id}: only a qualified opportunity may be approved")
    contract = direct_submit.validate_target(target_id, selected["contract"])
    document = _read(targets_path)
    if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("targets"), list):
        raise ValueError("target whitelist must be a version 1 object")
    if any(isinstance(row, dict) and row.get("id") == target_id for row in document["targets"]):
        raise ValueError(f"target already exists: {target_id}")
    document["targets"].append(contract)
    _write(targets_path, document)
    return contract


def next_steps(target_id: str) -> dict:
    return {
        "target": target_id,
        "steps": [
            {"stage": "dry_run", "command": f"python3 direct_submit.py --target {target_id} --kit <kit.json> --dry-run"},
            {"stage": "execute_one", "command": f"python3 direct_submit.py --target {target_id} --kit <kit.json>"},
            {"stage": "mail_verification", "command": "python3 mail_sweeper.py --dry-run && python3 mail_sweeper.py --loop"},
            {"stage": "public_verification", "command": "node verify_link.mjs --pending --update-status"},
        ],
        "success_rule": "Only verify_link.mjs can promote a published dofollow link to success.",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Construct the reviewed backlink workflow.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("discover", help="ingest candidate records without qualifying them")
    p.add_argument("--input", required=True)
    p.add_argument("--out", default=str(DEFAULT_OPPORTUNITIES))

    p = sub.add_parser("review", help="validate independently verified direct contracts")
    p.add_argument("--opportunities", default=str(DEFAULT_OPPORTUNITIES))
    p.add_argument("--out", default=str(DEFAULT_OPPORTUNITIES))

    p = sub.add_parser("approve", help="add exactly one qualified contract to the whitelist")
    p.add_argument("--opportunities", default=str(DEFAULT_OPPORTUNITIES))
    p.add_argument("--target", required=True)
    p.add_argument("--targets", default=str(DEFAULT_TARGETS))

    p = sub.add_parser("next", help="print the operator handoff after approval")
    p.add_argument("--target", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "discover":
            result = discover(args.input, args.out)
        elif args.command == "review":
            result = review(args.opportunities, args.out)
        elif args.command == "approve":
            result = approve(args.opportunities, args.target, args.targets)
        else:
            result = next_steps(args.target)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"workflow error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
