#!/usr/bin/env python3
"""Links bun-profile again from the finished release build of /workspace/wt/parser with one rlib replaced.
usage: relink.py <tag> [<path of a replacement libbun_js_parser-*.rlib>]      (run it through /workspace/tools/lk)
The link command, its inputs and flags are read from build/release/build.ninja. Outputs go to $OUT/<tag>/ (default
/tmp/paren-seam/link): bun-profile, bun-profile.linker-map, link.log. Nothing is written into the worktree.
A ThinLTO cache ($CACHE, default /tmp/paren-seam/thinlto-cache) makes every link after the first one short.
Without a replacement the result must be byte-identical to build/release/bun-profile (the check of the method)."""
import os, re, subprocess, sys, time
tag = sys.argv[1]; repl = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
R = '/workspace/wt/parser/build/release'
out = os.environ.get('OUT', '/tmp/paren-seam/link') + '/' + tag
cache = os.environ.get('CACHE', '/tmp/paren-seam/thinlto-cache')
os.makedirs(out, exist_ok=True); os.makedirs(cache, exist_ok=True)
text = open(R + '/build.ninja').read().replace('$\n', '')
edge = None; lines = text.split('\n')
for i, l in enumerate(lines):
    if l.startswith('build bun-profile |') and ': link ' in l: edge = i; break
assert edge is not None, 'link edge not found'
explicit = lines[edge].split(': link ', 1)[1].split(' | ')[0].split()
ldflags = None
for l in lines[edge + 1:edge + 12]:
    if l.startswith('  ldflags = '): ldflags = l[len('  ldflags = '):]
assert ldflags
n = 0
for i, x in enumerate(explicit):
    if re.search(r'/libbun_js_parser-[0-9a-f]+\.rlib$', x):
        if repl: explicit[i] = repl
        n += 1
assert n == 1, n
open(out + '/bun-profile.rsp', 'w').write('\n'.join(explicit) + '\n')
ldflags = ldflags.replace('-Wl,-Map=' + R + '/bun-profile.linker-map', '-Wl,-Map=' + out + '/bun-profile.linker-map')
assert out in ldflags
cmd = '/usr/lib/llvm-23/bin/clang++ @%s/bun-profile.rsp -Wl,@bun-profile.lazy.rsp %s -Wl,--thinlto-cache-dir=%s -o %s/bun-profile' % (out, ldflags, cache, out)
open(out + '/link.cmd', 'w').write(cmd + '\n')
t = time.time()
r = subprocess.run(cmd, shell=True, cwd=R, capture_output=True, text=True)
open(out + '/link.log', 'w').write(r.stdout + r.stderr)
print(tag, 'rc', r.returncode, 'seconds', int(time.time() - t), 'load', open('/proc/loadavg').read().split()[0])
if r.returncode: print((r.stdout + r.stderr)[-4000:])
sys.exit(r.returncode)
