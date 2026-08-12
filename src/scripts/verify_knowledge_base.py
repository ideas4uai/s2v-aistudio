"""Report what is actually in the Content Studio Knowledge Base.

Reads the collection off disk. `GET /api/content-studio/knowledge` cannot answer this
question on its own: it filters on the caller's uid, and returns an empty list — 200, no
error — for a caller who is not the documents' owner. Unauthenticated it returns 401.
Either way "0 documents" is indistinguishable from "no documents visible to you", which
is how a populated Knowledge Base got reported as empty.

Usage:  py src/scripts/verify_knowledge_base.py [--universe aiqa-engineer] [--min 1]
Exits non-zero if --min is given and fewer documents are present.
"""
import argparse
import collections
import glob
import json
import os
import sys

COLLECTION = os.path.join('outputs', 'content-studio', 'contentStudioKnowledge')


def normalise(value):
    """Mirror normalizeUniverse in knowledgeContext.ts: slug-ish, case-insensitive."""
    return str(value or '').strip().lower().replace(' ', '-')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--universe', default=None, help='Only count this universe slug')
    ap.add_argument('--min', type=int, default=None, help='Fail if fewer than this many')
    args = ap.parse_args()

    if not os.path.isdir(COLLECTION):
        print(f'Knowledge Base directory does not exist: {COLLECTION}')
        print('That is genuinely empty — nothing has ever been written here.')
        return 1 if args.min else 0

    docs, unreadable = [], []
    for path in sorted(glob.glob(os.path.join(COLLECTION, '*.json'))):
        try:
            docs.append(json.load(open(path, encoding='utf-8')))
        except Exception as exc:
            unreadable.append((os.path.basename(path), exc))

    if args.universe:
        want = normalise(args.universe)
        docs = [d for d in docs if normalise(d.get('universe')) == want]

    print(f'{COLLECTION}')
    print(f'  documents: {len(docs)}')
    if unreadable:
        print(f'  UNREADABLE: {len(unreadable)}')
        for name, exc in unreadable:
            print(f'    {name}: {exc}')

    by_universe = collections.Counter(normalise(d.get('universe')) or '(none)' for d in docs)
    by_category = collections.Counter(d.get('category') or '(none)' for d in docs)
    by_owner = collections.Counter(str(d.get('userId') or d.get('ownerId') or '(none)') for d in docs)

    for label, counter in (('universe', by_universe), ('category', by_category), ('owner', by_owner)):
        print(f'  by {label}:')
        for key, n in sorted(counter.items()):
            print(f'    {n:3d}  {key}')

    empty = [d.get('title') for d in docs if not (d.get('content') or '').strip()]
    if empty:
        # A document that exists but says nothing contributes nothing to a prompt.
        print(f'  WARNING: {len(empty)} document(s) have empty content: {empty}')

    if args.min is not None and len(docs) < args.min:
        print(f'FAIL: expected at least {args.min}, found {len(docs)}')
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
