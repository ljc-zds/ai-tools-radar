#!/usr/bin/env python3
"""Anonymous, bounded HTTP checks for already-submitted comments. No LLM or browser."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import functools
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl

from bs4 import BeautifulSoup
import state

HERE = Path(__file__).resolve().parent
DEFAULT = HERE / 'run/comment-experiment/submissions.json'
MAX_BYTES = 2_500_000


def clean_url(url):
    u = urlsplit(url)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password:
        raise ValueError('invalid public URL')
    if any(k.lower() in ('unapproved', 'moderation-hash', 'preview', 'preview_id', 'preview_nonce')
           for k, _ in parse_qsl(u.query)):
        raise ValueError('private preview URL is not public evidence')
    return urlunsplit((u.scheme, u.netloc, u.path or '/', u.query, ''))


def host(url):
    return (urlsplit(url).hostname or '').lower().removeprefix('www.').rstrip('.')


def guard(url, root, fake_ip_dns=False):
    url = clean_url(url)
    if host(url) != root:
        raise ValueError('redirect changed source host')
    # Some local DNS proxies map public hostnames into the RFC 2544 benchmark range.
    # Opt in only for those hostname resolutions; literal IPs and other private ranges stay blocked.
    name = urlsplit(url).hostname
    try:
        literal = ipaddress.ip_address(name)
    except ValueError:
        literal = None
    if literal and not literal.is_global:
        raise ValueError('non-public literal address')
    addresses = socket.getaddrinfo(urlsplit(url).hostname, None)
    def allowed(value):
        ip = ipaddress.ip_address(value)
        return ip.is_global or (fake_ip_dns and literal is None and ip.version == 4
                                and ip in ipaddress.ip_network('198.18.0.0/15'))
    if not addresses or any(not allowed(a[4][0]) for a in addresses):
        raise ValueError('non-public address')
    return url


def fetch(url, previous=None, fake_ip_dns=False):
    """No cookies, credentials, browser, JS, or automatic cross-host redirects."""
    current = clean_url(url)
    root = host(current)
    started = time.monotonic()
    for hop in range(5):
        current = guard(current, root, fake_ip_dns)
        remaining = 25 - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError('request budget exceeded')
        with tempfile.TemporaryDirectory(prefix='comment-watch-') as td:
            body, headers = Path(td)/'body', Path(td)/'headers'
            args = ['curl', '-q', '--compressed', '--silent', '--show-error',
                    '--proto', '=http,https', '--connect-timeout', '8',
                    '--max-time', str(remaining), '--max-filesize', str(MAX_BYTES),
                    '--output', str(body), '--dump-header', str(headers),
                    '--write-out', '%{http_code}', '--url', current]
            if previous and previous.get('final_url') == current and previous.get('status') not in ('unknown', 'blocked'):
                for name, key in [('If-None-Match', 'etag'), ('If-Modified-Since', 'last_modified')]:
                    value = previous.get(key)
                    if value and not re.search(r'[\r\n\x00]', value):
                        args += ['--header', f'{name}: {value}']
            p = subprocess.run(args, capture_output=True, timeout=remaining+2)
            if p.returncode:
                raise OSError(f'curl exit {p.returncode}')
            status = int(p.stdout)
            raw = headers.read_text(errors='replace').replace('\r\n', '\n')
            block = [b for b in raw.split('\n\n') if b.startswith('HTTP/')][-1]
            h = {k.lower().strip(): v.strip() for line in block.splitlines()[1:]
                 if ':' in line for k, v in [line.split(':', 1)]}
            if 300 <= status < 400 and status != 304 and h.get('location'):
                current = clean_url(urljoin(current, h['location']))
                continue
            data = body.read_bytes() if body.exists() else b''
            if len(data) > MAX_BYTES:
                raise ValueError('body too large')
            return {'http_status': status, 'final_url': current, 'headers': h,
                    'body': data, 'requests': hop+1}
    raise ValueError('too many redirects')


def normalized(text):
    return ' '.join(text.split())


def inspect(row, response):
    code, headers = response['http_status'], response['headers']
    base = {'http_status': code, 'final_url': response['final_url'], 'links': [],
            'comment_present': False, 'etag': headers.get('etag'),
            'last_modified': headers.get('last-modified')}
    if code in (401, 403, 429):
        return dict(base, status='blocked', reason=f'HTTP {code}')
    if code in (404, 410):
        return dict(base, status='page_missing', reason=f'HTTP {code}')
    if code != 200 or 'html' not in headers.get('content-type', '').lower():
        return dict(base, status='unknown', reason='not a successful HTML response')
    soup = BeautifulSoup(response['body'], 'html.parser')
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    if re.search(r'just a moment|access denied|verify.*human|security check', title, re.I) or soup.select_one('#challenge-form'):
        return dict(base, status='blocked', reason='challenge page')
    # Static HTML evidence only. Do not count templates, scripts or explicitly hidden nodes.
    for node in soup.select('script,style,template,noscript,[hidden],[aria-hidden="true"]'):
        node.decompose()
    for node in list(soup.select('[style]')):
        if node.attrs and re.search(r'display\s*:\s*none|visibility\s*:\s*hidden', node.get('style', ''), re.I):
            node.decompose()
    container = soup.find(id='comment-'+str(row['comment_id']))
    if container is None:
        container = soup.find(id='div-comment-'+str(row['comment_id']))
    if container is None:
        return dict(base, status='not_public', reason='comment absent from public HTML')
    text = normalized(container.get_text(' ', strip=True))
    if normalized(row['comment']) not in text:
        return dict(base, status='unknown', reason='comment ID found but text differs')
    if re.search(r'awaiting moderation|waiting for approval|in attesa di moderazione', text, re.I):
        return dict(base, status='not_public', reason='moderation notice')
    base['comment_present'] = True
    for a in container.find_all('a', href=True):
        url = urljoin(response['final_url'], a['href'])
        if urlsplit(url).scheme in ('http', 'https') and host(url) == host(row['website']):
            base['links'].append({'href': url, 'rel': sorted(set(a.get('rel', []))),
                                  'anchor': a.get_text(' ', strip=True)})
    robots = [m.get('content', '') for m in soup.select('meta[name="robots"],meta[name="googlebot"]')]
    robots.append(headers.get('x-robots-tag', ''))
    base['robots'] = ', '.join(filter(None, robots)).lower()
    return dict(base, status='public_link' if base['links'] else 'public_comment_only', reason='matched comment ID and text')


def fingerprint(result):
    return {k: result.get(k) for k in ('status', 'links', 'comment_present', 'robots')}


def check(row, previous=None, fetcher=fetch):
    try:
        response = fetcher(row['url'], previous)
        if response['http_status'] == 304:
            if not previous or previous.get('final_url') != response['final_url']:
                raise ValueError('304 without matching cached evidence')
            result = dict(previous, revalidated=True)
        else:
            result = inspect(row, response)
            result['revalidated'] = False
    except Exception as exc:
        result = {'status': 'unknown', 'reason': type(exc).__name__, 'links': [], 'comment_present': False}
    result['checked_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
    result['ever_public'] = bool(result['status'] == 'public_link' or (previous or {}).get('ever_public'))
    return result


def key_for(row):
    return hashlib.sha256(json.dumps([clean_url(row['url']), str(row['comment_id']), row['website'], row['comment']], ensure_ascii=False).encode()).hexdigest()


def run(rows, prior, fetcher=fetch, today=None):
    today = today or dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    previous = prior.get('results', {})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda r: check(r, previous.get(key_for(r)), fetcher), rows))
    changed, due, completed = [], [], set(prior.get('milestones', []))
    for row, result in zip(rows, results):
        key = key_for(row)
        old = previous.get(key)
        if old is None or fingerprint(result) != fingerprint(old):
            changed.append({'domain': row['domain'], 'url': row['url'], 'before': old.get('status') if old else None, **result})
        for day in row.get('followup_dates', []):
            marker = key+':'+day
            if day <= today and marker not in completed:
                due.append({'domain': row['domain'], 'date': day, 'status': result['status'], 'ever_public': result['ever_public']})
                completed.add(marker)
    counts = {}
    for result in results:
        counts[result['status']] = counts.get(result['status'], 0)+1
    saved = {'version': 1, 'results': {key_for(r): v for r, v in zip(rows, results)}, 'milestones': sorted(completed)}
    return saved, {'checked': len(rows), 'counts': counts, 'changes': changed, 'milestones': due}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=path.name+'.tmp.')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=DEFAULT)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--quiet-unchanged', action='store_true')
    parser.add_argument('--fake-ip-dns', action='store_true',
                        help='Allow this machine\'s DNS proxy to resolve manifest hostnames to 198.18.0.0/15')
    args = parser.parse_args()
    rows = json.loads(args.manifest.read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError('manifest must be a nonempty list')
    for row in rows:
        key_for(row)
        clean_url(row['website'])
        if not str(row['comment_id']).isdigit() or not row['comment'].strip():
            raise ValueError('missing comment ID or text')
    cache = args.cache or args.manifest.parent/'watch-cache.json'
    cache.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    def transaction():
        prior = json.loads(cache.read_text()) if cache.exists() else {}
        saved, report = run(rows, prior, functools.partial(fetch, fake_ip_dns=args.fake_ip_dns))
        report['elapsed_seconds'] = round(time.monotonic()-start, 2)
        atomic_json(cache.with_name(cache.stem+'-latest.json'), report)
        atomic_json(cache, saved)
        return report
    report = state.with_file_lock(str(cache), transaction)
    if not args.quiet_unchanged or report['changes'] or report['milestones']:
        print(json.dumps(report, ensure_ascii=False))
    # Observations remain separate from the delivery ledger: missing HTML is not rejection.
    # No submission, claim release, automatic browser fallback, or LLM calls occur here.


if __name__ == '__main__':
    main()
