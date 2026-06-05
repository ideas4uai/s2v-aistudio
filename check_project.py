import json, sys
d = json.load(sys.stdin)
s = d['scenes'][0]
print('scene character:', s.get('character'))
print('project universeId:', d.get('universeId'))
print('project universe present:', bool(d.get('universe')))
if d.get('universe'):
    chars = d['universe'].get('characters', [])
    veer = next((c for c in chars if c.get('name','').lower() == 'veer'), None)
    print('VEER in universe:', bool(veer))
    if veer:
        print('  useLoRA:', veer.get('useLoRA'))
