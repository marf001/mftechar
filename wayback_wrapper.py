import sys, json, urllib.request, urllib.error, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

domain = sys.argv[1]
results = {'dominio': domain}

def availability_api(url):
    req = urllib.request.Request(f'https://archive.org/wayback/available?url={url}', headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {'error': str(e)[:60]}

# Closest snapshot now
data = availability_api(domain)
snap = data.get('archived_snapshots', {}).get('closest', {})
if snap.get('available'):
    results['closest'] = snap['url']
    results['closest_timestamp'] = snap['timestamp']
    results['closest_status'] = snap['status']

print(json.dumps(results))
