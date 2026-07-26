import subprocess, sys, json, re, os, signal

exe = r'C:\Users\Martin\AppData\Local\Python\pythoncore-3.14-64\Scripts\sherlock.exe'
user = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 90

proc = subprocess.Popen(
    [exe, '--print-found', '--no-color', '--timeout', '10', user],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    cwd=os.path.dirname(exe)
)
try:
    stdout, stderr = proc.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    proc.kill()
    stdout, stderr = proc.communicate()

text = stdout.decode('utf-8', errors='replace')
results = []
for line in text.split('\n'):
    m = re.match(r'^\[\+\]\s+(.+?):\s+(https?://.+)', line)
    if m:
        results.append({'nombre': m.group(1).strip(), 'url': m.group(2).strip()})

print(json.dumps({'usuario': user, 'resultados': results, 'total': len(results)}))
