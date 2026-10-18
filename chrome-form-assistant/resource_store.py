"""Read-only source catalog and local transactional per-product workflow ledger."""
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

STATES = {'candidate', 'filled', 'submitted', 'skipped', 'review_needed'}
TYPES = {'all', 'historical_blog', 'candidate'}
STATUSES = {'all', 'live', 'lost', 'unknown', 'unverified'}
ROUTE_KEYS = {'p', 'page', 'id', 'post', 'post_id', 'article', 'article_id', 'entry', 'cat', 'category', 'slug', 'lang', 'action', 'view', 'type'}

def canonical_url(raw):
    """Preserve route parameters; omit trackers and reject credential-bearing query names."""
    if not isinstance(raw, str) or not 1 <= len(raw) <= 4000 or re.search(r'[\x00-\x20\\]', raw): raise ValueError('URL 无效。')
    parts = urlsplit(raw)
    if parts.scheme.lower() not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None: raise ValueError('URL 无效。')
    if parts.fragment.startswith(('/', '!')): raise ValueError('暂不支持 hash 路由目标。')
    host = parts.hostname.lower().encode('idna').decode('ascii')
    if not re.fullmatch(r'[a-z0-9.:-]+', host): raise ValueError('URL 无效。')
    port = parts.port
    if port is not None and not 1 <= port <= 65535: raise ValueError('URL 无效。')
    netloc = '[' + host + ']' if ':' in host else host
    if port and port != (443 if parts.scheme.lower() == 'https' else 80): netloc += ':' + str(port)
    if re.search(r'(?i)(?:token|password|secret|session|api[_-]?key|authorization)[=/]', parts.path): raise ValueError('URL 路径疑似包含凭据。')
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True, max_num_fields=100):
        if re.search(r'(?i)token|password|passwd|secret|session|api.?key|auth|credential|cookie|email|nonce|signature|^code$', key): raise ValueError('URL 查询参数疑似包含凭据。')
        if len(key) > 100 or len(value) > 300: raise ValueError('URL 查询参数过长。')
        if key.lower().startswith('utm_') or key.lower() in {'fbclid', 'gclid', 'ref', 'referrer'}: continue
        query.append((key, value))
    query.sort(key=lambda pair: pair[0])
    return urlunsplit((parts.scheme.lower(), netloc, parts.path or '/', urlencode(query), ''))

def product_identity(url): return hashlib.sha256(canonical_url(url).encode()).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat(timespec='seconds')
def short(raw, size=300): return raw[:size] if isinstance(raw, str) else ''

class Catalog:
    def __init__(self, data_dir):
        self.items = {}
        self.unavailable = []
        for filename, kind in [('verified_blog_comments.json', 'historical_blog'), ('library.json', 'candidate')]:
            try:
                rows = json.loads((Path(data_dir) / filename).read_text())
                if not isinstance(rows, list): raise ValueError()
            except (OSError, ValueError):
                self.unavailable.append(filename)
                continue
            for row in rows:
                if not isinstance(row, dict): continue
                try: url = canonical_url(row.get('post_url') if kind == 'historical_blog' else row.get('url'))
                except (ValueError, UnicodeError): continue
                source = {'file': filename, 'kind': kind, 'label': '历史博客记录（非本次验证）' if kind == 'historical_blog' else '未验证候选（非已确认目录或表单）', 'observedAt': short(row.get('checked_at') or row.get('first_seen') if kind == 'historical_blog' else row.get('seen'), 80), 'reportedStatus': row.get('status_now') if kind == 'historical_blog' and row.get('status_now') in {'live', 'lost', 'unknown'} else 'unknown' if kind == 'historical_blog' else 'unverified'}
                item = self.items.get(url)
                if item is None:
                    item = {'url': url, 'domain': urlsplit(url).hostname, 'title': short(row.get('title')) or urlsplit(url).hostname, 'type': kind, 'platform': 'blog' if kind == 'historical_blog' else short(row.get('plat'), 80), 'sources': [], 'status': source['reportedStatus'], 'observedAt': source['observedAt']}
                    self.items[url] = item
                if kind == 'historical_blog':
                    previous = next((s for s in item['sources'] if s['file'] == filename), None)
                    if previous is None or source['observedAt'] > previous['observedAt']:
                        if previous: item['sources'].remove(previous)
                        source['reportedStatuses'] = [source['reportedStatus']]
                        item.update(type=kind, status=source['reportedStatus'], observedAt=source['observedAt'], statusConflict=False)
                        item['sources'].append(source)
                    elif source['observedAt'] == previous['observedAt']:
                        statuses = sorted(set(previous.get('reportedStatuses', [previous['reportedStatus']])) | {source['reportedStatus']})
                        previous['reportedStatuses'] = statuses
                        previous['reportedStatus'] = statuses[0] if len(statuses) == 1 else 'unknown'
                        item.update(status=previous['reportedStatus'], statusConflict=len(statuses) > 1)
                elif not any(s['file'] == filename for s in item['sources']): item['sources'].append(source)
        self.ordered = sorted(self.items.values(), key=lambda item: (item['type'] != 'historical_blog', item['url']))

class Ledger:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS records (
              product_key TEXT NOT NULL, product_name TEXT NOT NULL, product_url TEXT NOT NULL,
              url TEXT NOT NULL, domain TEXT NOT NULL, state TEXT NOT NULL,
              updated_at TEXT NOT NULL, filled_count INTEGER NOT NULL DEFAULT 0,
              detail TEXT NOT NULL DEFAULT '', confirmed_at TEXT,
              confirmation_source TEXT, PRIMARY KEY(product_key,url))''')
            db.execute('''CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY, product_key TEXT NOT NULL, url TEXT NOT NULL,
              action TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL)''')
        try: Path(path).chmod(0o600)
        except OSError: pass
    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=8)
        db.row_factory = sqlite3.Row
        try:
            with db: yield db
        finally: db.close()
    def states(self, product_key):
        with self.connect() as db: return {r['url']: dict(r) for r in db.execute('SELECT * FROM records WHERE product_key=?', (product_key,))}
    def lookup(self, product_key, url, records=None):
        url = canonical_url(url)
        records = self.states(product_key) if records is None else records
        row = records.get(url)
        same = [r['url'] for r in records.values() if r['state'] == 'submitted' and r['domain'] == urlsplit(url).hostname and r['url'] != url]
        return {'url': url, 'state': row['state'] if row else 'candidate', 'updatedAt': row['updated_at'] if row else None, 'filledCount': row['filled_count'] if row else 0, 'detail': row['detail'] if row else '', 'confirmedAt': row['confirmed_at'] if row else None, 'confirmationSource': row['confirmation_source'] if row else None, 'submittedOnSameDomain': sorted(same)[:5], 'sameDomainSubmittedCount': len(same)}
    def transition(self, kit, raw):
        if not isinstance(raw, dict): raise ValueError()
        url = canonical_url(raw.get('url'))
        action = raw.get('action')
        if action not in {'filled', 'submitted', 'skipped', 'undo'}: raise ValueError()
        if action == 'submitted' and raw.get('humanConfirmed') is not True: raise ValueError('必须由用户确认已手动提交。')
        count = raw.get('filledCount', 0)
        if type(count) is not int or not 0 <= count <= 40: raise ValueError()
        aborted = raw.get('aborted', False)
        if type(aborted) is not bool: raise ValueError()
        if action == 'filled' and count < 1: raise ValueError('未实际填写，不能记为已填写。')
        stamp = now(); key = kit['id']
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM records WHERE product_key=? AND url=?', (key, url)).fetchone()
            if old and old['state'] == 'submitted':
                # No fill, skip or undo can erase a human-reported submission.
                return self.lookup(key, url, {row['url']: dict(row) for row in db.execute('SELECT * FROM records WHERE product_key=?', (key,))})
            state = {'filled': 'review_needed' if aborted else 'filled', 'submitted': 'submitted', 'skipped': 'skipped', 'undo': 'review_needed'}[action]
            detail = {'filled': 'partial_fill' if aborted else 'filled', 'submitted': 'human_confirmed', 'skipped': 'user_skipped', 'undo': 'undo_requires_review'}[action]
            confirmed_at = stamp if action == 'submitted' else None
            source = '用户手动确认' if action == 'submitted' else None
            previous_count = old['filled_count'] if old else 0
            db.execute('''INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(product_key,url) DO UPDATE SET product_name=excluded.product_name,
              state=excluded.state,updated_at=excluded.updated_at,filled_count=excluded.filled_count,
              detail=excluded.detail,confirmed_at=excluded.confirmed_at,confirmation_source=excluded.confirmation_source''',
              (key, short(kit['product'].get('name')), canonical_url(kit['product']['url']), url, urlsplit(url).hostname, state, stamp, count if action == 'filled' else previous_count, detail, confirmed_at, source))
            db.execute('INSERT INTO events(product_key,url,action,at,detail) VALUES (?,?,?,?,?)', (key,url,action,stamp,detail))
        return self.lookup(key, url)

def list_resources(catalog, ledger, kit, raw):
    if not isinstance(raw, dict): raise ValueError()
    kind, state, status = raw.get('type', 'all'), raw.get('state', 'all'), raw.get('status', 'all')
    query, page, page_size = raw.get('query', ''), raw.get('page', 1), raw.get('pageSize', 10)
    if kind not in TYPES or state not in STATES | {'all'} or status not in STATUSES: raise ValueError()
    if not isinstance(query, str) or len(query) > 200 or type(page) is not int or not 1 <= page <= 100000 or type(page_size) is not int or page_size not in (10, 20): raise ValueError()
    records = ledger.states(kit['id'])
    # Include manually visited pages in the local workflow even when absent from source files.
    items = list(catalog.ordered)
    for url in sorted(records):
        if url not in catalog.items:
            items.append({'url': url, 'domain': urlsplit(url).hostname, 'title': urlsplit(url).hostname, 'type': 'candidate', 'platform': '', 'sources': [{'file': 'local-ledger', 'kind': 'candidate', 'label': '手动访问的未验证候选', 'observedAt': records[url]['updated_at'], 'reportedStatus': 'unverified'}], 'status': 'unverified', 'observedAt': records[url]['updated_at']})
    matched = []
    query = query.casefold().strip()
    for item in items:
        item_state = records.get(item['url'], {}).get('state', 'candidate')
        if kind != 'all' and item['type'] != kind or state != 'all' and item_state != state or status != 'all' and item['status'] != status: continue
        if query and query not in (item['url'] + ' ' + item['title'] + ' ' + item['platform']).casefold(): continue
        matched.append(item)
    start = (page - 1) * page_size
    return {'items': [{**item, 'workflow': ledger.lookup(kit['id'], item['url'], records)} for item in matched[start:start+page_size]], 'total': len(matched), 'page': page, 'pageSize': page_size, 'sourceUnavailable': catalog.unavailable}
