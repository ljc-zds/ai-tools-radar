import json
import tempfile
import unittest
from pathlib import Path

import workflow


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write_json(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def valid_contract(self):
        return {
            "domain": "directory.example",
            "endpoint": "https://directory.example/submit",
            "method": "POST",
            "field_map": {"name": "product.name", "url": "product.url"},
            "headers": {"Content-Type": "application/x-www-form-urlencoded"},
            "expected_status": [202],
            "response_contains": "queued",
            "rate_limit_seconds": 86400,
            "link_rel_expected": "nofollow",
        }

    def test_discover_keeps_candidates_unqualified(self):
        source = self.write_json("candidates.json", [{"id": "one", "domain": "directory.example"}])
        result = workflow.discover(source, self.root / "opportunities.json")
        self.assertEqual(result["opportunities"][0]["status"], "candidate")

    def test_review_requires_and_validates_contract(self):
        source = self.write_json("opportunities.json", {"version": 1, "opportunities": [
            {"id": "missing", "domain": "missing.example"},
            {"id": "valid", "domain": "directory.example", "contract": self.valid_contract()},
        ]})
        result = workflow.review(source, self.root / "reviewed.json")
        statuses = {row["id"]: row["status"] for row in result["opportunities"]}
        self.assertEqual(statuses, {"missing": "needs_contract", "valid": "qualified"})

    def test_approve_only_accepts_qualified(self):
        source = self.write_json("reviewed.json", {"version": 1, "opportunities": [{
            "id": "valid", "domain": "directory.example", "status": "qualified",
            "contract": self.valid_contract(),
        }]})
        targets = self.write_json("targets.json", {"version": 1, "targets": []})
        approved = workflow.approve(source, "valid", targets)
        self.assertEqual(approved["endpoint"], "https://directory.example/submit")
        self.assertEqual(len(json.loads(targets.read_text())["targets"]), 1)

        unqualified = self.write_json("unqualified.json", {"version": 1, "opportunities": [
            {"id": "nope", "domain": "x.example", "status": "candidate"}
        ]})
        with self.assertRaises(ValueError):
            workflow.approve(unqualified, "nope", targets)

    def test_next_steps_separate_mail_and_public_verification(self):
        stages = [step["stage"] for step in workflow.next_steps("valid")["steps"]]
        self.assertEqual(stages, ["dry_run", "execute_one", "mail_verification", "public_verification"])
        self.assertIn("verify_link.mjs", workflow.next_steps("valid")["success_rule"])


def contract():
    return {
        "domain": "directory.example",
        "endpoint": "https://directory.example/submit",
        "method": "POST",
        "field_map": {"name": "product.name"},
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "expected_status": [202],
        "response_contains": "queued",
        "rate_limit_seconds": 86400,
        "link_rel_expected": "nofollow",
    }


class LocalWorkflowTests(unittest.TestCase):
    def test_discover_stays_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.json"
            out = Path(tmp) / "opportunities.json"
            source.write_text(json.dumps([{"id": "one", "domain": "directory.example", "source": "manual"}]))
            result = workflow.discover(source, out)
            self.assertEqual(result["opportunities"][0]["status"], "candidate")

    def test_review_requires_contract_and_qualifies_valid_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opportunities.json"
            path.write_text(json.dumps({"version": 1, "opportunities": [
                {"id": "missing", "domain": "directory.example", "status": "candidate"},
                {"id": "ready", "domain": "directory.example", "status": "candidate", "contract": contract()},
            ]}))
            result = workflow.review(path, path)
            statuses = {row["id"]: row["status"] for row in result["opportunities"]}
            self.assertEqual(statuses, {"missing": "needs_contract", "ready": "qualified"})

    def test_approve_only_qualified_target_changes_whitelist(self):
        with tempfile.TemporaryDirectory() as tmp:
            opportunities = Path(tmp) / "opportunities.json"
            targets = Path(tmp) / "targets.json"
            opportunities.write_text(json.dumps({"version": 1, "opportunities": [
                {"id": "ready", "domain": "directory.example", "status": "qualified", "contract": contract()}
            ]}))
            targets.write_text(json.dumps({"version": 1, "targets": []}))
            added = workflow.approve(opportunities, "ready", targets)
            self.assertEqual(added["id"], "ready")
            self.assertEqual(len(json.loads(targets.read_text())["targets"]), 1)

    def test_next_steps_keeps_mail_and_public_verification_separate(self):
        result = workflow.next_steps("ready")
        stages = [step["stage"] for step in result["steps"]]
        self.assertEqual(stages, ["dry_run", "execute_one", "mail_verification", "public_verification"])
        self.assertIn("verify_link.mjs", result["success_rule"])



if __name__ == "__main__":
    unittest.main()
