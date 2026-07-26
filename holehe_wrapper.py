import subprocess, sys, json, re

exe = r'C:\Users\Martin\AppData\Local\Python\pythoncore-3.14-64\Scripts\holehe.exe'
email = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 60

proc = subprocess.Popen(
    [exe, '--no-color', '--only-used', email],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
try:
    stdout, stderr = proc.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    proc.kill()
    stdout, stderr = proc.communicate()

text = stdout.decode('utf-8', errors='replace')
results = []
for line in text.split('\n'):
    m = re.match(r'^\[\+\]\s+(.+)', line)
    if m:
        results.append({'servicio': m.group(1).strip()})

print(json.dumps({'email': email, 'resultados': results, 'total': len(results)}))
