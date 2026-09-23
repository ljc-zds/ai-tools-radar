#!/usr/bin/env python3
"""Contract tests for the direct-submission whitelist."""

import json
import os
import tempfile
import threading
import unittest
import urllib.parse
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
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

    def test_rejects_endpoint_query_path_parameters_and_fragment(self):
        endpoints = (
            "https://api.example.com/submit?api_key=very-secret",
            "https://api.example.com/submit?token=very-secret",
            "https://api.example.com/submit;token=very-secret",
            "https://api.example.com/v1;token=very-secret/submit",
            "https://api.example.com/submit%3Btoken=very-secret",
            "https://api.example.com/submit#token=very-secret",
        )
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint):
                with self.assertRaisesRegex(ValueError, "query|path parameters|fragment"):
                    direct_submit.validate_target("bad", valid_record(endpoint=endpoint))

    def test_rejects_trimmed_field_map_key_collisions(self):
        with self.assertRaisesRegex(ValueError, "collision"):
            direct_submit.validate_target(
                "bad", valid_record(field_map={"name": "product.name", " name ": "product.url"})
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

    def test_rejects_credential_like_field_names_and_kit_paths(self):
        field_maps = (
            {"apiKey": "product.name"},
            {"password": "product.name"},
            {"authorization": "product.name"},
            {"credential": "product.name"},
            {"credentials": "product.name"},
            {"bearer": "product.name"},
            {"JWTToken": "product.name"},
        )
        for field_map in field_maps:
            with self.subTest(field_map=field_map):
                with self.assertRaisesRegex(ValueError, "credential-like"):
                    direct_submit.validate_target(
                        "bad", valid_record(field_map=field_map)
                    )

    def test_accepts_only_public_scalar_and_indexed_kit_paths(self):
        paths = (
            "product.name",
            "product.url",
            "product.og_image",
            "product.submitter.name",
            "product.submitter.email",
            "product.positioning.one_liner",
            "product.facts_for_screening",
            "product.audience_note",
            "product.categories.0",
            "product.tags.1",
            "product.positioning.differentiators.0",
            "copy.taglines.1",
            "copy.descriptions.xs_50.0",
            "copy.descriptions.s_150.0",
            "copy.descriptions.m_300.0",
            "copy.descriptions.l_510.0",
        )
        for path in paths:
            with self.subTest(path=path):
                normalized = direct_submit.validate_target(
                    "fixture", valid_record(field_map={"monkey": path})
                )
                self.assertEqual(normalized["field_map"], {"monkey": path})

    def test_rejects_non_public_kit_paths(self):
        paths = (
            "product.private_token",
            "product.submitter.credential",
            "product.submitter.credentials",
            "product.submitter.bearer",
            "product.submitter.JWTToken",
            "compliance.forbidden_claims_regex.0",
            "comment_voice.tone.0",
            "product.unknown",
            "product.categories",
            "product.categories.first",
            "copy.descriptions.s_150",
            "copy.descriptions.s_150.first",
            "copy.descriptions.credentials.0",
            "copy.descriptions.private_token.0",
        )
        for path in paths:
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "public kit path"):
                    direct_submit.validate_target(
                        "bad", valid_record(field_map={"name": path})
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
        for statuses in ([99], [300], [401], [429], [500], [600], ["202"], [200, 202.0]):
            with self.subTest(statuses=statuses):
                with self.assertRaisesRegex(ValueError, "expected_status"):
                    direct_submit.validate_target(
                        "bad", valid_record(expected_status=statuses)
                    )

    def test_rejects_empty_response_assertion(self):
        with self.assertRaisesRegex(ValueError, "response assertion"):
            direct_submit.validate_target("bad", valid_record(response_contains="  "))

    def test_rejects_non_positive_rate_limit(self):
        for value in (0, -1, True, "86400", float("nan"), float("inf")):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "rate_limit_seconds"):
                    direct_submit.validate_target(
                        "bad", valid_record(rate_limit_seconds=value)
                    )

    def test_large_integer_rate_limit_validates_without_overflow(self):
        limit = 10**400
        target = direct_submit.validate_target(
            "fixture", valid_record(rate_limit_seconds=limit)
        )
        self.assertEqual(target["rate_limit_seconds"], limit)

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

    def test_build_payload_resolves_public_list_indices(self):
        target = {
            **self.target,
            "field_map": {
                "category": "product.categories.1",
                "description": "copy.descriptions.s_150.0",
            },
        }
        kit = {
            **self.kit,
            "product": {**self.kit["product"], "categories": ["AI", "SaaS"]},
            "copy": {"descriptions": {"s_150": ["Public description"]}},
        }

        self.assertEqual(
            direct_submit.build_payload(target, kit),
            {"category": "SaaS", "description": "Public description"},
        )

    def test_build_payload_rejects_invalid_or_out_of_range_list_indices(self):
        kit = {**self.kit, "product": {**self.kit["product"], "categories": ["AI"]}}
        for path in ("product.categories.first", "product.categories.2"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "field_map"):
                    direct_submit.build_payload(
                        {**self.target, "field_map": {"category": path}}, kit
                    )

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
        old = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        state._append(state.STATE_FILE, {"src": self.target["domain"], "status": "draft", "ts": old})
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
        target = self.target
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

    def test_production_opener_does_not_follow_loopback_redirect(self):
        hits = {"first": 0, "second": 0}

        class SecondHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits["second"] += 1
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                pass

        second = ThreadingHTTPServer(("127.0.0.1", 0), SecondHandler)

        class FirstHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits["first"] += 1
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{second.server_port}/followed")
                self.end_headers()

            def log_message(self, *_args):
                pass

        first = ThreadingHTTPServer(("127.0.0.1", 0), FirstHandler)
        for server in (first, second):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join)
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

        with self.assertRaises(urllib.error.HTTPError) as caught:
            direct_submit.DEFAULT_OPENER.open(f"http://127.0.0.1:{first.server_port}/start", timeout=2)
        caught.exception.close()
        self.assertEqual(caught.exception.code, 302)
        self.assertEqual(hits, {"first": 1, "second": 0})

    def test_missing_public_payload_does_not_consume_claim(self):
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))
        result = direct_submit.submit_target(
            self.target, {"product": {"name": "Signal Layer", "url": None}}, opener=opener
        )

        self.assertEqual(result, {"status": "manual", "reason": "payload_contract_error"})
        self.assertIsNone(state.current_status(self.target["domain"]))
        self.assertFalse(os.path.exists(state._claim_marker(self.target["domain"])))
        self.assertEqual(len(opener.calls), 0)
        self.assertEqual(self.pending_tasks()[0]["payload"], None)

    def test_recent_ledger_state_rate_limits_without_side_effects(self):
        state.upsert_submission(self.target["domain"], "draft", source="fixture")
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "skipped", "reason": "rate_limited"})
        self.assertFalse(os.path.exists(state._claim_marker(self.target["domain"])))
        self.assertEqual(len(opener.calls), 0)
        self.assertEqual(self.pending_tasks(), [])

    def test_old_ledger_state_does_not_block_submission(self):
        old = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        state._append(state.STATE_FILE, {"src": self.target["domain"], "status": "draft", "ts": old})
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))

        result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result["status"], "pending_review")
        self.assertEqual(len(opener.calls), 1)

    def test_malformed_ledger_timestamp_fails_closed_before_claim(self):
        for index, stamp in enumerate(("not-a-time", None, "2026-09-23", "2026-09-23T12:00:00+25:00")):
            with self.subTest(stamp=stamp):
                target = {**self.target, "domain": f"badtime{index}.example.com"}
                state._append(state.STATE_FILE, {"src": target["domain"], "status": "draft", "ts": stamp})
                opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))

                result = direct_submit.submit_target(target, self.kit, opener=opener)

                self.assertEqual(result, {"status": "manual", "reason": "invalid_ledger_timestamp"})
                self.assertFalse(os.path.exists(state._claim_marker(target["domain"])))
                self.assertEqual(len(opener.calls), 0)

    def test_non_2xx_response_fails_closed_even_if_target_is_tampered(self):
        target = {**self.target, "expected_status": [500]}
        opener = RecordingOpener(FakeResponse(status=500, url=target["endpoint"]))
        with self.assertRaisesRegex(ValueError, "expected_status"):
            direct_submit.submit_target(target, self.kit, opener=opener)
        self.assertFalse(os.path.exists(state._claim_marker(target["domain"])))
        self.assertEqual(len(opener.calls), 0)

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

    def test_non_public_payload_path_is_rejected_before_claim_or_network(self):
        target = {**self.target, "field_map": {"name": "product.missing"}}
        opener = RecordingOpener(FakeResponse(url=target["endpoint"]))

        with self.assertRaisesRegex(ValueError, "public kit path"):
            direct_submit.submit_target(target, self.kit, opener=opener)

        self.assertEqual(len(opener.calls), 0)
        self.assertIsNone(state.current_status(self.target["domain"]))
        self.assertFalse(os.path.exists(state._claim_marker(self.target["domain"])))
        self.assertEqual(self.pending_tasks(), [])

    def test_ledger_promotion_failure_is_manual_and_keeps_claim(self):
        opener = RecordingOpener(FakeResponse(url=self.target["endpoint"]))
        with mock.patch.object(state, "upsert_submission", side_effect=OSError("disk full")):
            result = direct_submit.submit_target(self.target, self.kit, opener=opener)

        self.assertEqual(result, {"status": "manual", "reason": "ledger_write_error"})
        self.assertEqual(len(opener.calls), 1)
        self.assertTrue(os.path.exists(state._claim_marker(self.target["domain"])))
        self.assertEqual(self.pending_tasks()[0]["blocker"], "ledger_write_error")


class CliTests(unittest.TestCase):
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

    def write_json(self, filename, value):
        path = os.path.join(self.tempdir.name, filename)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(value, handle)
        return path

    def paths(self, records=None):
        targets = self.write_json(
            "targets.json",
            {
                "version": 1,
                "targets": records
                or [
                    {
                        "id": "fixture",
                        **valid_record(headers={"Accept": "future-sensitive-value"}),
                    }
                ],
            },
        )
        kit = self.write_json(
            "kit.json",
            {
                "product": {
                    "name": "Signal Layer",
                    "url": "https://signal.example/",
                    "private_token": "kit-secret",
                }
            },
        )
        return targets, kit

    def run_main(self, argv):
        stdout = StringIO()
        stderr = StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = direct_submit.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_dry_run_prints_only_declared_payload_without_side_effects(self):
        targets, kit = self.paths()
        with mock.patch.object(
            direct_submit.DEFAULT_OPENER, "open", side_effect=AssertionError("network called")
        ):
            code, stdout, stderr = self.run_main(
                ["--targets", targets, "--target", "fixture", "--kit", kit, "--dry-run"]
            )

        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(stdout),
            {
                "status": "validated",
                "target": "fixture",
                "payload": {
                    "name": "Signal Layer",
                    "url": "https://signal.example/",
                },
            },
        )
        self.assertEqual(stderr, "")
        self.assertNotIn("future-sensitive-value", stdout)
        self.assertNotIn("kit-secret", stdout)
        self.assertIsNone(state.current_status("submit.example.com"))
        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))
        self.assertEqual(state._read_jsonl(state.HUMAN_TASKS_FILE), [])

    def test_dry_run_rejects_non_public_kit_path_without_side_effects(self):
        targets, kit = self.paths(
            [
                {
                    "id": "fixture",
                    **valid_record(field_map={"name": "product.private_token"}),
                }
            ]
        )
        with mock.patch.object(direct_submit, "submit_target") as submit:
            code, stdout, stderr = self.run_main(
                ["--targets", targets, "--target", "fixture", "--kit", kit, "--dry-run"]
            )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("public kit path", stderr)
        self.assertNotIn("kit-secret", stderr)
        submit.assert_not_called()
        self.assertIsNone(state.current_status("submit.example.com"))
        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))
        self.assertEqual(state._read_jsonl(state.HUMAN_TASKS_FILE), [])

    def test_unknown_target_has_no_side_effects(self):
        targets, kit = self.paths()

        code, stdout, stderr = self.run_main(
            ["--targets", targets, "--target", "missing", "--kit", kit, "--dry-run"]
        )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("unknown target", stderr)
        self.assertNotIn("Traceback", stderr)
        self.assertIsNone(state.current_status("submit.example.com"))
        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))

    def test_duplicate_target_flags_are_rejected_without_side_effects(self):
        targets, kit = self.paths()
        with mock.patch.object(direct_submit, "submit_target") as submit:
            code, stdout, stderr = self.run_main(
                [
                    "--targets",
                    targets,
                    "--target",
                    "missing",
                    "--target",
                    "fixture",
                    "--kit",
                    kit,
                ]
            )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("exactly one --target", stderr)
        self.assertNotIn("Traceback", stderr)
        submit.assert_not_called()
        self.assertIsNone(state.current_status("submit.example.com"))
        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))

    def test_selected_target_requires_entire_whitelist_to_be_valid(self):
        targets, kit = self.paths(
            [
                {"id": "fixture", **valid_record()},
                {"id": "invalid-other", **valid_record(method="GET")},
            ]
        )

        code, stdout, stderr = self.run_main(
            ["--targets", targets, "--target", "fixture", "--kit", kit, "--dry-run"]
        )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("POST method required", stderr)
        self.assertNotIn("Traceback", stderr)
        self.assertIsNone(state.current_status("submit.example.com"))

    def test_malformed_kit_fails_cleanly_before_submission(self):
        targets, _ = self.paths()
        kit = self.write_json("bad-kit.json", {"product": {"name": "Signal Layer"}})
        with mock.patch.object(direct_submit, "DEFAULT_TARGETS_PATH", Path(targets)), mock.patch.object(direct_submit, "submit_target") as submit:
            code, stdout, stderr = self.run_main(
                ["--target", "fixture", "--kit", kit]
            )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn("field_map path is missing", stderr)
        self.assertNotIn("Traceback", stderr)
        submit.assert_not_called()
        self.assertIsNone(state.current_status("submit.example.com"))

    def test_handled_execution_result_is_json_and_returns_zero(self):
        targets, kit = self.paths()
        result = {"status": "manual", "reason": "network_error"}
        with mock.patch.object(direct_submit, "DEFAULT_TARGETS_PATH", Path(targets)), mock.patch.object(direct_submit, "submit_target", return_value=result):
            code, stdout, stderr = self.run_main(
                ["--target", "fixture", "--kit", kit]
            )

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), result)
        self.assertEqual(stderr, "")

    def test_live_alternate_targets_rejected_before_kit_or_state_access(self):
        targets, kit = self.paths()
        with (
            mock.patch.object(direct_submit, "load_targets", side_effect=AssertionError("targets read")),
            mock.patch.object(direct_submit, "_load_json", side_effect=AssertionError("kit read")),
            mock.patch.object(state, "current_status", side_effect=AssertionError("ledger read")),
            mock.patch.object(state, "claim_delivery", side_effect=AssertionError("claim")),
            mock.patch.object(state, "human_task_add", side_effect=AssertionError("task")),
            mock.patch.object(direct_submit.DEFAULT_OPENER, "open", side_effect=AssertionError("network")),
        ):
            code, stdout, stderr = self.run_main(
                ["--targets", targets, "--target", "fixture", "--kit", kit]
            )

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("--targets", stderr)
        self.assertFalse(os.path.exists(state._claim_marker("submit.example.com")))


if __name__ == "__main__":
    unittest.main()
