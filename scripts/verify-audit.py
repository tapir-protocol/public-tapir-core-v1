#!/usr/bin/env python3
"""Rebuild the auditor-pinned Git tree from the retained source snapshot."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'verification/audited-contracts.json').read_text())

def object_hash(kind, data):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).digest()

def tree_hash(entries):
    parts = []
    for name, value in sorted(entries.items(), key=lambda item: item[0] + ('/' if isinstance(item[1], dict) else '')):
        directory = isinstance(value, dict)
        digest = tree_hash(value) if directory else object_hash('blob', value)
        parts.append((b'40000 ' if directory else b'100644 ') + name.encode() + b'\0' + digest)
    return object_hash('tree', b''.join(parts))

tree = {}
for source in manifest['files']:
    location = manifest['originals'].get(source, source)
    parts = Path(source).parts[1:]
    current = tree
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = (ROOT / location).read_bytes()
actual = tree_hash(tree).hex()
assert actual == manifest['tree'], f'Audit snapshot changed: {actual}'
assert actual == '55a702beef28000dd016c7090f2d5dc6a446c213', 'Unexpected audit target'
# Only test fixtures may be added outside the original production-source manifest.
extras = set(str(p.relative_to(ROOT)) for p in (ROOT / 'contracts').rglob('*.sol')) - set(manifest['files'])
assert all(p.startswith('contracts/mock/') for p in extras), f'Unreviewed production additions: {extras}'
print(f'Audited contracts tree verified: {actual}')
