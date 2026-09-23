#!/usr/bin/env python3
"""Contract tests for the direct-submission whitelist."""

import json
import os
import tempfile
import unittest
import urllib.parse
from unittest import mock

import direct_submit
import state


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
        placeholders = (
            "TODO",
            "TODO: map field",
            "YOUR_FIELD",
            "{field}",
            "<name>",
            "replace-me",
        )
        for placeholder in placeholders:
            with self.subTest(placeholder=placeholder):
                with self.assertRaisesRegex(ValueError, "field_map"):
                    direct_submit.validate_target(
                        "bad", valid_record(field_map={"name": placeholder})
                    )

    def test_rejects_invalid_headers_mapping(self):
        for headers in ([], {"": "application/json"}, {"Accept": ""}, {"Accept": 7}):
            with self.subTest(headers=headers):
                with self.assertRaisesRegex(ValueError, "headers"):
                    direct_submit.validate_target("bad", valid_record(headers=headers))

    def test_rejects_credential_bearing_headers(self):
        secret_headers = (
            "Authorization",
            "Proxy-Authorization",
            "Cookie",
            "Set-Cookie",
            "X-API-Key",
            "API-Key",
            "X-Auth-Token",
            "X-Secret-Key",
            "X-Client-Secret",
            "Client-Secret",
            "X-CSRF-Token",
            "Bearer-Token",
        )
        for header in secret_headers:
            with self.subTest(header=header):
                with self.assertRaisesRegex(ValueError, "allowed header"):
                    direct_submit.validate_target(
                        "bad", valid_record(headers={header: "must-not-be-committed"})
                    )

    def test_rejects_arbitrary_unapproved_headers(self):
        with self.assertRaisesRegex(ValueError, "allowed header"):
            direct_submit.validate_target(
                "bad", valid_record(headers={"X-Trace": "not-approved"})
            )

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
            "login",
            "payment",
            "terms_acceptance",
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


class DeliveryClaimTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.path_patches = []
        for name, filename in (
            ("DIR", ""),
            ("STATE_FILE", "state.jsonl"),
            ("EVENTS_FILE", "events.jsonl"),
            ("HUMAN_TASKS_FILE", "human_tasks.jsonl"),
        ):
            value = self.tempdir.name if not filename else os.path.join(self.tempdir.name, filename)
            patcher = mock.patch.object(state, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_claim_is_atomic_and_records_delivery_ambiguous(self):
        first = state.claim_delivery("Submit.Example.com", source="direct_submit")
        second = state.claim_delivery("submit.example.com", source="direct_submit")

        self.assertEqual(
            first, {"claimed": True, "from": None, "to": "delivery_ambiguous"}
        )
        self.assertEqual(
            second,
            {"claimed": False, "from": "delivery_ambiguous", "to": "delivery_ambiguous"},
        )
        self.assertEqual(state.current_status("submit.example.com")["status"], "delivery_ambiguous")

    def test_claim_backfills_marker_for_blocking_legacy_state(self):
        state.upsert_submission("submit.example.com", "pending_review", source="fixture")

        result = state.claim_delivery("submit.example.com", source="direct_submit")

        self.assertFalse(result["claimed"])
        self.assertTrue(os.path.exists(state._claim_marker("submit.example.com")))

    def test_claim_rolls_back_marker_when_guarded_ledger_write_fails(self):
        with mock.patch.object(state, "with_file_lock", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                state.claim_delivery("submit.example.com", source="direct_submit")

        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))

    def test_claim_keeps_marker_when_audit_write_fails(self):
        with mock.patch.object(state, "record_event", side_effect=RuntimeError("audit full")):
            result = state.claim_delivery("submit.example.com", source="direct_submit")

        self.assertTrue(result["claimed"])
        self.assertTrue(os.path.exists(state._claim_marker("submit.example.com")))
        self.assertEqual(state.current_status("submit.example.com")["status"], "delivery_ambiguous")


class FakeResponse:
    def __init__(self, *, status=202, body=b'{"status":"queued"}', url=None):
        self.status = status
        self._body = body
        self._url = url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, limit=-1):
        return self._body[:limit]

    def geturl(self):
        return self._url


class ResponseWithoutGeturl:
    status = 202

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, limit=-1):
        return b'{"status":"queued"}'[:limit]


class RecordingOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def __call__(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class SubmitTargetTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        for name, filename in (
            ("DIR", ""),
            ("STATE_FILE", "state.jsonl"),
            ("EVENTS_FILE", "events.jsonl"),
            ("HUMAN_TASKS_FILE", "human_tasks.jsonl"),
        ):
            value = self.tempdir.name if not filename else os.path.join(self.tempdir.name, filename)
            patcher = mock.patch.object(state, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.target = direct_submit.validate_target(
            "fixture",
            valid_record(headers={"Accept": "application/json", "User-Agent": "DirectSubmit/1"}),
        )
        self.kit = {
            "product": {"name": "Signal Layer", "url": "https://signal.example/"},
            "unmapped_secret": "do-not-send",
        }

    def pending_tasks(self):
        return state._read_jsonl(state.HUMAN_TASKS_FILE)

    def test_build_payload_uses_only_declared_dotted_paths(self):
        payload = direct_submit.build_payload(self.target, self.kit)

        self.assertEqual(
            payload,
            {"name": "Signal Layer", "url": "https://signal.example/"},
        )

    def test_build_payload_rejects_a_missing_or_non_scalar_path(self):
        for field_map in (
            {"name": "product.missing"},
            {"product": "product"},
        ):
            with self.subTest(field_map=field_map):
                with self.assertRaisesRegex(ValueError, "field_map"):
                    direct_submit.build_payload({**self.target, "field_map": field_map}, self.kit)

    def test_submit_sends_exact_request_once_and_records_pending_review(self):
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "pending_review", "http_status": 202})
        self.assertEqual(len(opener.calls), 1)
        request, timeout = opener.calls[0]
        self.assertEqual(timeout, 20)
        self.assertEqual(request.full_url, "https://api.example.com/v1/submit")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            urllib.parse.parse_qs(request.data.decode("ascii")),
            {"name": ["Signal Layer"], "url": ["https://signal.example/"]},
        )
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("User-agent"), "DirectSubmit/1")
        self.assertEqual(
            request.get_header("Content-type"), "application/x-www-form-urlencoded"
        )
        self.assertEqual(state.current_status(self.target["domain"])["status"], "pending_review")

    def test_second_run_skips_without_network_access(self):
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))

        direct_submit.submit_target(self.target, self.kit, opener=opener)
        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "skipped", "reason": "already_claimed"})
        self.assertEqual(len(opener.calls), 1)

    def test_contract_mismatch_queues_manual_without_retry(self):
        opener = RecordingOpener(
            FakeResponse(body=b'{"status":"unknown"}', url=self.target["endpoint"])
        )

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "response_assertion_failed"})
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(self.pending_tasks()[0]["blocker"], "response_assertion_failed")

    def test_generic_200_is_not_success(self):
        target = {**self.target, "expected_status": [200]}
        opener = RecordingOpener(FakeResponse(status=200, body=b"OK", url=target["endpoint"]))

        result = direct_submit.submit_target(target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "response_assertion_failed"})
        self.assertEqual(len(opener.calls), 1)

    def test_unexpected_status_queues_manual_without_retry(self):
        opener = RecordingOpener(FakeResponse(status=200, url=self.target["endpoint"]))

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "unexpected_status"})
        self.assertEqual(len(opener.calls), 1)

    def test_redirect_response_is_manual_without_followup_request(self):
        target = {**self.target, "expected_status": [302]}
        opener = RecordingOpener(
            FakeResponse(status=302, body=b"queued", url=target["endpoint"])
        )

        result = direct_submit.submit_target(target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "redirect_response"})
        self.assertEqual(len(opener.calls), 1)

    def test_production_redirect_handler_refuses_redirects(self):
        handler = direct_submit.NoRedirectHandler()
        request = direct_submit.urllib.request.Request(self.target["endpoint"])

        redirected = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://attacker.invalid/collect",
        )

        self.assertIsNone(redirected)
        self.assertTrue(
            any(
                isinstance(item, direct_submit.NoRedirectHandler)
                for item in direct_submit.DEFAULT_OPENER.handlers
            )
        )

    def test_unvalidated_targets_are_rejected_before_claim_or_network(self):
        cases = (
            {"endpoint": "http://api.example.com/v1/submit"},
            {"endpoint": "https://attacker.invalid/v1/submit"},
            {"headers": {"Authorization": "secret"}},
        )
        for index, overrides in enumerate(cases):
            with self.subTest(overrides=overrides):
                target = {
                    **self.target,
                    "domain": f"unsafe{index}.example.com",
                    **overrides,
                }
                opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))
                with self.assertRaises(ValueError):
                    direct_submit.submit_target(target, self.kit, opener=opener)
                self.assertEqual(len(opener.calls), 0)
                self.assertIsNone(state.current_status(target["domain"]))

    def test_missing_final_response_url_fails_closed(self):
        responses = (FakeResponse(url=None), ResponseWithoutGeturl())
        for index, response in enumerate(responses):
            with self.subTest(response=type(response).__name__):
                target = {**self.target, "domain": f"missingurl{index}.example.com"}
                opener = RecordingOpener(response)

                result = direct_submit.submit_target(target, self.kit, opener=opener)

                self.assertEqual(
                    result, {"status": "manual", "reason": "unsafe_response_url"}
                )
                self.assertEqual(len(opener.calls), 1)

    def test_auth_and_payment_statuses_are_never_success(self):
        cases = ((401, "login_wall"), (403, "login_wall"), (407, "login_wall"), (402, "payment_required"))
        for index, (status, reason) in enumerate(cases):
            with self.subTest(status=status):
                target = {
                    **self.target,
                    "domain": f"status{index}.example.com",
                    "expected_status": [status],
                }
                opener = RecordingOpener(
                    FakeResponse(status=status, body=b"queued", url=self.target["endpoint"])
                )

                result = direct_submit.submit_target(target, self.kit, opener=opener)

                self.assertEqual(result, {"status": "manual", "reason": reason})
                self.assertEqual(len(opener.calls), 1)

    def test_unsafe_final_url_queues_manual(self):
        for final_url in ("http://api.example.com/result", "https://attacker.invalid/result"):
            with self.subTest(final_url=final_url):
                target = {
                    **self.target,
                    "domain": final_url.split("//", 1)[1].split("/", 1)[0] + ".source.example.com",
                }
                opener = RecordingOpener(FakeResponse(url=final_url))
                result = direct_submit.submit_target(target, self.kit, opener=opener)
                self.assertEqual(result, {"status": "manual", "reason": "unsafe_response_url"})
                self.assertEqual(len(opener.calls), 1)

    def test_response_walls_are_manual_even_when_positive_text_is_present(self):
        cases = (
            ("Please log in to continue. queued", "login_wall"),
            ("Unauthorized: OAuth authentication is required. queued", "login_wall"),
            ("Complete the reCAPTCHA challenge. queued", "captcha_required"),
            ("Upgrade your paid plan to submit. queued", "payment_required"),
            ("You must accept the terms and conditions. queued", "terms_acceptance_required"),
        )
        for index, (body, reason) in enumerate(cases):
            with self.subTest(reason=reason):
                target = {**self.target, "domain": f"submit{index}.example.com"}
                opener = RecordingOpener(
                    FakeResponse(body=body.encode(), url=self.target["endpoint"])
                )
                result = direct_submit.submit_target(target, self.kit, opener=opener)
                self.assertEqual(result, {"status": "manual", "reason": reason})
                self.assertEqual(len(opener.calls), 1)

    def test_network_error_queues_manual_without_retry(self):
        opener = RecordingOpener(error=OSError("connection reset"))

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "network_error"})
        self.assertEqual(len(opener.calls), 1)

    def test_payload_contract_error_queues_manual_without_network_access(self):
        target = {**self.target, "field_map": {"name": "product.missing"}}
        opener = RecordingOpener(FakeResponse(url=target["endpoint"]))

        result = direct_submit.submit_target(target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "payload_contract_error"})
        self.assertEqual(len(opener.calls), 0)
        self.assertEqual(self.pending_tasks()[0]["blocker"], "payload_contract_error")

    def test_ledger_promotion_failure_is_manual_and_keeps_claim(self):
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))
        with mock.patch.object(state, "upsert_submission", side_effect=OSError("disk full")):
            result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "ledger_write_error"})
        self.assertEqual(len(opener.calls), 1)
        self.assertTrue(os.path.exists(state._claim_marker(self.target["domain"])))
        self.assertEqual(self.pending_tasks()[0]["blocker"], "ledger_write_error")


if __name__ == "__main__":
    unittest.main()
