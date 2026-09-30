#!/usr/bin/env python3
"""Compiles a copy of src/js_parser with the rustc command of the release build; writes assembly and an object file.
usage: [OUT=<scratch dir>] [RELAX=1] run.py <tag> <directory of a copy of src/js_parser>
Needs a finished `bun run build:release` in /workspace/wt/parser (dependencies are read from build/release/rust-target).
Nothing is written into the worktree. One run is about 30 s of CPU. RELAX=1 allows unused code in the copy.
The code is what the crate compiles to before the link (codegen-units=1, lto=off in the release profile of the crate)."""
import json, os, subprocess, sys, glob, time
tag, src = sys.argv[1], os.path.abspath(sys.argv[2])
root = '/workspace/wt/parser/build/release'
manifest = json.load(open(glob.glob(root + '/rust-target/units/bun_js_parser-*.json')[0]))
out = os.environ.get('OUT', '/tmp/paren-seam/out') + '/' + tag
os.makedirs(out, exist_ok=True)
args = []
a = manifest['args']
i = 0
while i < len(a):
    x = a[i]
    if x == 'src/js_parser/lib.rs': args.append(src + '/lib.rs')
    elif x.startswith('--emit='): args.append('--emit=asm,obj')
    elif x.startswith('--error-format') or x.startswith('--json='): pass
    elif x == '--out-dir': args += ['--out-dir', out]; i += 1
    elif x == '-Z' and a[i + 1] == 'binary-dep-depinfo': i += 1
    elif x == '-C' and a[i + 1].startswith('debuginfo='): args += ['-C', 'debuginfo=0']; i += 1
    else: args.append(x)
    i += 1
if os.environ.get('RELAX'): args += ['-A', 'unused_mut', '-A', 'unused_variables', '-A', 'unused_assignments', '-A', 'dead_code']
env = dict(os.environ); env.update(manifest['env'])
lp = manifest.get('libraryPath')
if lp: env[lp['variable']] = ':'.join(lp['prepend'] + [env.get(lp['variable'], '')])
t = time.time()
r = subprocess.run([manifest['rustc']] + args, cwd=manifest['cwd'], env=env, capture_output=True, text=True)
open(out + '/rustc.log', 'w').write(r.stdout + r.stderr)
print(tag, 'rc', r.returncode, 'seconds', int(time.time() - t), sorted(os.listdir(out)))
if r.returncode: print((r.stdout + r.stderr)[-6000:])
sys.exit(r.returncode)
