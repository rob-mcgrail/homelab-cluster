#!/usr/bin/env python3
import os, sys, json, time, http.client

# Read env directly
with open(os.path.expanduser('~') + '/homelab-cluster/.api_keys') as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ[k] = v

QB_USER = os.environ.get('QB_USERNAME', '')
QB_PASS = os.environ.get('QB_PASSWORD', '')

conn = http.client.HTTPConnection('localhost', 8080, timeout=10)

# Login
conn.request('POST', '/api/v2/auth/login', 
             body=f'username={QB_USER}&password={QB_PASS}',
             headers={'Content-Type': 'application/x-www-form-urlencoded'})
resp = conn.getresponse()
resp.read()
sid = None
for c in resp.getheader('set-cookie', '').split(';'):
    if 'SID=' in c:
        sid = c.split('SID=')[1].strip()

# Get torrents
conn.request('GET', '/api/v2/torrents/info', headers={'Cookie': f'SID={sid}'})
resp = conn.getresponse()
data = json.loads(resp.read().decode())

now = time.time()
print(f'Total torrents: {len(data)}')
for t in sorted(data, key=lambda x: x.get('added_on', 0), reverse=True):
    age_h = (now - t['added_on']) / 3600
    age_str = f'{age_h:.1f}h' if age_h < 72 else f'{age_h/24:.1f}d'
    print(f"hash={t['hash'][:8]} name={t['name'][:50]:50s} progress={t['progress']*100:5.1f}% size={t['total_size']/1024**3:.2f}GB dl={t['dlspeed']/1024:.0f}KB/s up={t['upspeed']/1024:.0f}KB/s seeds={t['num_seeds']}/{t['num_complete']} peers={t['num_leechs']}/{t['num_incomplete']} state={t['state']:12s} age={age_str} tags={t.get('tags','')} priority={t['priority']} cat={t.get('category','')}")

conn.close()