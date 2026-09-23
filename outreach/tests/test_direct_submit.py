#!/usr/bin/env python3
"""Contract tests for the direct-submission whitelist."""

import json
import os
import tempfile
import unittest

import direct_submit


def valid_record(**overrides):
    record = {
        "domain": "submit.example.com",
        "endpoint": "https://api.example.com/v1/submit",
        "method": "POST",
        "field_map": {"name": "product.name", "url": "product.url"},
        "headers": {"Accept": "application/json"},
        "expected_status": [202],
        "response_contains": "queued",
        "rate_limit_seconds": 86400,
        "link_rel_expected": "nofollow",
    }
    record.update(overrides)
    return record


class ValidateTargetTests(unittest.TestCase):
    def test_normalizes_a_valid_target(self):
        normalized = direct_submit.validate_target(
            "fixture", valid_record(method="post", domain="Submit.Example.com.")
        )

        self.assertEqual(normalized["id"], "fixture")
        self.assertEqual(normalized["domain"], "submit.example.com")
        self.assertEqual(normalized["method"], "POST")
        self.assertEqual(normalized["headers"], {"Accept": "application/json"})

    def test_rejects_missing_required_fields(self):
        record = valid_record()
        del record["headers"]

        with self.assertRaisesRegex(ValueError, "missing.*headers"):
            direct_submit.validate_target("bad", record)

    def test_rejects_non_https_endpoint(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            direct_submit.validate_target(
                "bad", valid_record(endpoint="http://api.example.com/submit")
            )

    def test_rejects_cross_owner_endpoint(self):
        with self.assertRaisesRegex(ValueError, "same-owner"):
            direct_submit.validate_target(
                "bad", valid_record(endpoint="https://other.example/submit")
            )

    def test_accepts_same_owner_public_suffix_domains(self):
        normalized = direct_submit.validate_target(
            "fixture",
            valid_record(
                domain="directory.co.uk",
                endpoint="https://submit.directory.co.uk/add",
            ),
        )

        self.assertEqual(normalized["domain"], "directory.co.uk")

    def test_rejects_credential_bearing_endpoint(self):
        with self.assertRaisesRegex(ValueError, "credentials"):
            direct_submit.validate_target(
                "bad", valid_record(endpoint="https://user:secret@api.example.com/submit")
            )

    def test_rejects_non_post_method(self):
        with self.assertRaisesRegex(ValueError, "POST"):
            direct_submit.validate_target("bad", valid_record(method="GET"))

    def test_rejects_incomplete_field_mapping(self):
        for field_map in ({}, {"name": ""}, {"": "product.name"}, {"name": 7}):
            with self.subTest(field_map=field_map):
                with self.assertRaisesRegex(ValueError, "field_map"):
                    direct_submit.validate_target("bad", valid_record(field_map=field_map))

    def test_rejects_placeholder_field_mapping(self):
        with self.assertRaisesRegex(ValueError, "field_map"):
            direct_submit.validate_target(
                "bad", valid_record(field_map={"name": "TODO"})
            )

    def test_rejects_invalid_headers_mapping(self):
        for headers in ([], {"": "application/json"}, {"Accept": ""}, {"Accept": 7}):
            with self.subTest(headers=headers):
                with self.assertRaisesRegex(ValueError, "headers"):
                    direct_submit.validate_target("bad", valid_record(headers=headers))

    def test_rejects_empty_expected_status(self):
        with self.assertRaisesRegex(ValueError, "expected_status"):
            direct_submit.validate_target("bad", valid_record(expected_status=[]))

    def test_rejects_invalid_expected_status(self):
        for statuses in ([99], [600], ["202"], [200, 202.0]):
            with self.subTest(statuses=statuses):
                with self.assertRaisesRegex(ValueError, "expected_status"):
                    direct_submit.validate_target(
                        "bad", valid_record(expected_status=statuses)
                    )

    def test_rejects_empty_response_assertion(self):
        with self.assertRaisesRegex(ValueError, "response assertion"):
            direct_submit.validate_target("bad", valid_record(response_contains="  "))

    def test_rejects_non_positive_rate_limit(self):
        for value in (0, -1, True, "86400"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "rate_limit_seconds"):
                    direct_submit.validate_target(
                        "bad", valid_record(rate_limit_seconds=value)
                    )

    def test_rejects_unknown_link_rel(self):
        with self.assertRaisesRegex(ValueError, "link_rel_expected"):
            direct_submit.validate_target(
                "bad", valid_record(link_rel_expected="unknown")
            )

    def test_rejects_unsafe_workflow_declarations(self):
        unsafe = (
            "paid",
            "reciprocal_link",
            "account_creation",
            "captcha",
            "browser_only",
        )
        for field in unsafe:
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, field):
                    direct_submit.validate_target("bad", valid_record(**{field: True}))


class LoadTargetsTests(unittest.TestCase):
    def write_json(self, value):
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        self.addCleanup(lambda: os.unlink(handle.name))
        with handle:
            json.dump(value, handle)
        return handle.name

    def test_loads_and_indexes_valid_targets(self):
        path = self.write_json(
            {"version": 1, "targets": [{"id": "fixture", **valid_record()}]}
        )

        targets = direct_submit.load_targets(path)

        self.assertEqual(list(targets), ["fixture"])
        self.assertEqual(targets["fixture"]["endpoint"], "https://api.example.com/v1/submit")

    def test_rejects_duplicate_target_ids(self):
        path = self.write_json(
            {
                "version": 1,
                "targets": [
                    {"id": "duplicate", **valid_record()},
                    {"id": "duplicate", **valid_record()},
                ],
            }
        )

        with self.assertRaisesRegex(ValueError, "duplicate"):
            direct_submit.load_targets(path)

    def test_rejects_invalid_document_shape(self):
        for document in ({}, {"version": 2, "targets": []}, {"version": 1, "targets": {}}):
            with self.subTest(document=document):
                path = self.write_json(document)
                with self.assertRaises(ValueError):
                    direct_submit.load_targets(path)


if __name__ == "__main__":
    unittest.main()
