import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comment_watch as w

ROW = {'domain': 'source.example', 'url': 'https://source.example/post',
       'comment_id': '12', 'comment': 'A specific suggestion.',
       'website': 'https://product.example', 'followup_dates': ['2026-10-05', '2026-10-28']}


def response(body='', code=200, headers=None):
    return {'http_status': code, 'final_url': ROW['url'],
            'headers': headers or {'content-type': 'text/html'}, 'body': body.encode()}


def comment(href='https://product.example', rel='nofollow ugc'):
    return f'<article id="comment-12"><a href="{href}" rel="{rel}">Author</a><p>A specific suggestion.</p></article>'


class WatchTests(unittest.TestCase):
    def test_public_link_rel_and_robots(self):
        result = w.inspect(ROW, response('<meta name="robots" content="noindex">'+comment()))
        self.assertEqual(result['status'], 'public_link')
        self.assertEqual(result['links'][0]['rel'], ['nofollow', 'ugc'])
        self.assertEqual(result['robots'], 'noindex')

    def test_exact_host_not_substring_or_redirect_parameter(self):
        for href in ['https://product.example.evil.test', 'https://evil.test/?url=https://product.example',
                     'https://evilproduct.example', 'javascript:product.example']:
            with self.subTest(href=href):
                self.assertEqual(w.inspect(ROW, response(comment(href)))['status'], 'public_comment_only')

    def test_link_elsewhere_is_not_our_comment(self):
        html = '<a href="https://product.example">Sidebar</a><div id="comment-12">A specific suggestion.</div>'
        self.assertEqual(w.inspect(ROW, response(html))['status'], 'public_comment_only')

    def test_hidden_templates_do_not_count(self):
        for before, after in [('<template>', '</template>'), ('<div hidden>', '</div>'),
                              ('<div style="display: none">', '</div>'), ('<script>', '</script>')]:
            with self.subTest(before=before):
                self.assertEqual(w.inspect(ROW, response(before+comment()+after))['status'], 'not_public')

    def test_missing_wrong_text_and_moderation(self):
        self.assertEqual(w.inspect(ROW, response('<h1>Article</h1>'))['status'], 'not_public')
        self.assertEqual(w.inspect(ROW, response(comment().replace('specific', 'different')))['status'], 'unknown')
        self.assertEqual(w.inspect(ROW, response(comment().replace('</p>', ' Awaiting moderation</p>')))['status'], 'not_public')

    def test_errors_are_not_missing_links(self):
        for code, expected in [(403, 'blocked'), (429, 'blocked'), (500, 'unknown'), (404, 'page_missing')]:
            self.assertEqual(w.inspect(ROW, response(code=code))['status'], expected)
        self.assertEqual(w.inspect(ROW, response('<title>Just a moment...</title>'+comment()))['status'], 'blocked')
        self.assertEqual(w.inspect(ROW, response(comment(), headers={'content-type': 'application/json'}))['status'], 'unknown')

    def test_304_needs_cached_evidence(self):
        getter = lambda *args: response(code=304)
        self.assertEqual(w.check(ROW, fetcher=getter)['status'], 'unknown')
        prev = w.inspect(ROW, response(comment()))
        self.assertEqual(w.check(ROW, prev, getter)['status'], 'public_link')

    def test_no_change_and_real_change(self):
        getter = lambda *args: response('<h1>Article</h1>')
        saved, report = w.run([ROW], {}, getter, '2026-09-28')
        self.assertEqual(len(report['changes']), 1)
        saved2, report2 = w.run([ROW], saved, getter, '2026-09-28')
        self.assertEqual(report2['changes'], [])
        _, report3 = w.run([ROW], saved2, lambda *args: response(comment()), '2026-09-28')
        self.assertEqual(report3['changes'][0]['status'], 'public_link')

    def test_rel_change_is_reported(self):
        saved, _ = w.run([ROW], {}, lambda *args: response(comment()), '2026-09-28')
        _, report = w.run([ROW], saved, lambda *args: response(comment(rel='')), '2026-09-28')
        self.assertEqual(len(report['changes']), 1)

    def test_milestones_fire_once_even_if_missed_day(self):
        getter = lambda *args: response('<h1>Article</h1>')
        saved, _ = w.run([ROW], {}, getter, '2026-09-28')
        saved, report = w.run([ROW], saved, getter, '2026-10-06')
        self.assertEqual(len(report['milestones']), 1)
        saved, report = w.run([ROW], saved, getter, '2026-10-07')
        self.assertFalse(report['milestones'])
        _, report = w.run([ROW], saved, getter, '2026-10-29')
        self.assertEqual(len(report['milestones']), 1)

    def test_network_failure_preserves_ever_public(self):
        saved, _ = w.run([ROW], {}, lambda *args: response(comment()), '2026-09-28')
        def timeout(*args):
            raise TimeoutError()
        after, report = w.run([ROW], saved, timeout, '2026-09-28')
        self.assertEqual(report['changes'][0]['status'], 'unknown')
        self.assertTrue(after['results'][w.key_for(ROW)]['ever_public'])

    def test_preview_and_unsafe_urls_rejected(self):
        for url in ['file:///etc/passwd', 'https://user:secret@source.example/',
                    ROW['url']+'?unapproved=12', ROW['url']+'?moderation-hash=private']:
            with self.assertRaises(ValueError):
                w.clean_url(url)
        with self.assertRaises(ValueError):
            w.guard('https://elsewhere.example/', 'source.example')
        with patch.object(w.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('127.0.0.1', 0))]):
            with self.assertRaises(ValueError):
                w.guard(ROW['url'], 'source.example')

    def test_changed_manifest_does_not_reuse_evidence(self):
        changed = copy.deepcopy(ROW)
        changed['comment'] = 'Another comment.'
        self.assertNotEqual(w.key_for(changed), w.key_for(ROW))

    def test_fake_ip_proxy_is_explicit_and_narrow(self):
        with patch.object(w.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('198.18.0.97', 0))]):
            with self.assertRaises(ValueError):
                w.guard(ROW['url'], 'source.example')
            self.assertEqual(w.guard(ROW['url'], 'source.example', True), ROW['url'])
            with self.assertRaises(ValueError):
                w.guard('http://198.18.0.97/', '198.18.0.97', True)
        with patch.object(w.socket, 'getaddrinfo', return_value=[(0, 0, 0, '', ('127.0.0.1', 0))]):
            with self.assertRaises(ValueError):
                w.guard(ROW['url'], 'source.example', True)


if __name__ == '__main__':
    unittest.main()
