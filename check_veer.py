import json, sys
data = sys.stdin.read()
us = json.loads(data)
for u in us:
    uid = u.get('id', '?')
    title = u.get('title', '?')
    chars = u.get('characters', [])
    veer = next((c for c in chars if c.get('name', '').lower() == 'veer'), None)
    print('Universe:', uid, '|', title, '| chars:', len(chars))
    if veer:
        print('  VEER useLoRA:', veer.get('useLoRA'))
        print('  VEER loraModelUrl:', str(veer.get('loraModelUrl', ''))[:70])
