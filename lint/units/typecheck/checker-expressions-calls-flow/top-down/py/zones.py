# Zones of every function of checker and binder in the order of typecheck.md (K3), over the call graph of checker-core-scratch/goanal.
# The ranges of the earlier layers are copied from checker-core-scratch/py/layers.py, checker-type-layers-topdown/py/layers.py
# and checker-relations-and-inference/py/layers.py. The twelve layers of this unit use the ranges of the bottom-up pass,
# minus the functions that an earlier layer already claims.
import json, os, re, collections
HERE = os.path.dirname(os.path.abspath(__file__))
CORE_SCRATCH = HERE + '/../../../checker-core-scratch'
REF = '/workspace/ref/typescript-go/internal/'
C = 'checker/checker.go'; R = 'checker/relater.go'; F = 'checker/flow.go'; I = 'checker/inference.go'
CORE = [
 ('MAPPER', 'checker/mapper.go', 1, 99999), ('UTIL', 'checker/utilities.go', 1, 99999),
 ('LINKS', 'checker/links.go', 1, 99999), ('TYPES', 'checker/types.go', 1, 99999),
 ('T-KEYS', C, 17471, 17775), ('K-OBJ', C, 25126, 25394), ('T-RSTACK', C, 18861, 18958),
 ('C-INIT', C, 908, 1503), ('D-SINK', C, 14052, 14168), ('S-MERGE', C, 14170, 14531),
 ('N-RESOLVE', 'binder/nameresolver.go', 1, 99999), ('N-RESOLVE', C, 2182, 2200), ('N-RESOLVE', C, 13991, 14050),
 ('N-DIAG', C, 1505, 2180), ('A-ALIAS', C, 14533, 15193), ('A-ALIAS', C, 15830, 15861), ('A-ALIAS', C, 16349, 16493),
 ('M-MODULE', C, 15195, 15828), ('M-MODULE', C, 16014, 16347), ('Q-ENTITY', C, 15863, 16012),
]
TYPEL = [
 ('K-LIT', C, 25396, 25676),
 ('K-PRED', C, 26348, 26371), ('K-PRED', C, 26575, 26770), ('K-PRED', C, 27729, 27794), ('K-PRED', C, 27926, 27987),
 ('K-PRED', C, 28278, 28281), ('K-PRED', C, 31607, 31612),
 ('K-GENERIC', C, 24991, 25074),
 ('K-UNION', C, 25677, 26146), ('K-UNION', C, 26771, 26802),
 ('K-INTERSECT', C, 26147, 26347), ('K-INTERSECT', C, 26372, 26574),
 ('T-TUPLE', C, 23410, 23693), ('T-TUPLE', C, 24791, 24804), ('T-TUPLE', C, 24820, 24990), ('T-TUPLE', R, 1915, 1946),
 ('T-DECLARED', C, 17413, 17470), ('T-DECLARED', C, 23779, 24034), ('T-DECLARED', C, 24040, 24060), ('T-DECLARED', C, 24217, 24224),
 ('T-ENUMVAL', C, 24035, 24039), ('T-ENUMVAL', C, 24061, 24216),
 ('T-TYPENODE', C, 22913, 23409), ('T-TYPENODE', C, 23694, 23778), ('T-TYPENODE', C, 24225, 24391), ('T-TYPENODE', C, 24690, 24697),
 ('T-CONSTRAINT', C, 17141, 17412), ('T-CONSTRAINT', C, 22047, 22162), ('T-CONSTRAINT', C, 27551, 27728), ('T-CONSTRAINT', C, 29255, 29267),
 ('T-BASE', C, 17030, 17131), ('T-BASE', C, 19281, 19406), ('T-BASE', C, 19612, 19711),
 ('T-MEMBERS', C, 19176, 19280), ('T-MEMBERS', C, 19712, 19919), ('T-MEMBERS', C, 20764, 21007), ('T-MEMBERS', C, 22163, 22213),
 ('T-UIMEMBERS', C, 21166, 21516), ('T-UIMEMBERS', C, 21528, 21828), ('T-UIMEMBERS', C, 13611, 13626), ('T-UIMEMBERS', C, 27795, 27828),
 ('T-LOOKUP', C, 18960, 19175), ('T-LOOKUP', C, 21517, 21527),
 ('T-APPARENT', C, 21829, 22006),
 ('T-SIGDECL', C, 19920, 20239),
 ('T-SIGSHAPE', R, 1708, 1914), ('T-SIGSHAPE', R, 1947, 2151), ('T-SIGSHAPE', C, 27855, 27925), ('T-SIGSHAPE', C, 9721, 9738),
 ('T-SIGSHAPE', C, 29124, 29134), ('T-SIGSHAPE', C, 17132, 17140),
 ('T-SIGINST', C, 19407, 19611), ('T-SIGINST', C, 20722, 20763),
 ('T-INSTANTIATE', C, 22007, 22046), ('T-INSTANTIATE', C, 22214, 22598), ('T-INSTANTIATE', C, 22632, 22637),
 ('T-INSTANTIATE', C, 22856, 22912), ('T-INSTANTIATE', C, 24602, 24661),
 ('T-SYMTYPE', C, 16495, 17029), ('T-SYMTYPE', C, 17777, 18468), ('T-SYMTYPE', C, 18617, 18859), ('T-SYMTYPE', C, 29198, 29227),
 ('T-WIDEN', C, 18469, 18616), ('T-WIDEN', C, 20566, 20648), ('T-WIDEN', C, 28282, 28311),
 ('K-KEYOF', C, 26803, 26944), ('K-KEYOF', C, 26957, 27045),
 ('K-INDEXED', C, 27046, 27516), ('K-INDEXED', C, 28025, 28128), ('K-INDEXED', C, 28152, 28162), ('K-INDEXED', C, 29414, 29448),
 ('K-SUBST', C, 26945, 26956), ('K-SUBST', C, 27517, 27550), ('K-SUBST', C, 25075, 25125), ('K-SUBST', C, 31694, 31702),
 ('K-COND', C, 24392, 24601), ('K-COND', C, 24662, 24689), ('K-COND', C, 22599, 22631), ('K-COND', C, 28129, 28151),
 ('T-MAPPED', C, 21008, 21165), ('T-MAPPED', C, 22638, 22855), ('T-MAPPED', C, 28250, 28277), ('T-MAPPED', C, 29135, 29186),
 ('K-TEMPLATE', C, 29268, 29413), ('K-TEMPLATE', R, 2354, 2558),
 ('K-IMPORTTYPE', C, 24698, 24790),
]
REL = [
 ('R-REL', R, 1, 422), ('R-ELAB', R, 424, 675), ('R-REL', R, 677, 870), ('R-DISCRIM', R, 872, 950), ('R-REL', R, 952, 1028),
 ('R-DISCRIM', R, 1030, 1268), ('R-REL', R, 1270, 1315), ('R-VARIANCE', R, 1317, 1485), ('R-SIGREL', R, 1487, 2313),
 ('R-REL', R, 2315, 2557), ('R-SIGREL', R, 2559, 2567), ('R-REL', R, 2569, 3933), ('R-VARIANCE', R, 3935, 3999),
 ('R-REL', R, 4001, 4019), ('R-DISCRIM', R, 4021, 4130), ('R-REL', R, 4132, 4471), ('R-SIGREL', R, 4473, 4608),
 ('R-REL', R, 4610, 5044),
 ('I-INFER', I, 1, 998), ('I-REVMAP', I, 1000, 1183), ('I-INFER', I, 1185, 1684),
]
# The twelve layers of this unit, as the bottom-up pass of the same unit cut them.
MINE = [
 ('F-UNREACH', C, 2398, 2477),
 ('E-CORE', C, 7419, 7942),
 ('E-ACCESS', C, 7944, 8064),
 ('E-LITERAL', C, 8066, 8210),
 ('E-ACCESS', C, 8212, 8355),
 ('E-CALL', C, 8357, 10131),
 ('E-FUNC', C, 10133, 10705),
 ('E-OPER', C, 10707, 11130),
 ('E-ACCESS', C, 11132, 12376),
 ('E-OPER', C, 12378, 13233),
 ('E-LITERAL', C, 13235, 13989),
 ('T-RETINFER', C, 20240, 20727),
 ('E-CTX', C, 29449, 30162),
 ('E-CALL', C, 30164, 30672),
 ('E-CTX', C, 30674, 31095),
 ('E-FACTS', C, 31097, 31347),
 ('F-NARROW', C, 31593, 31702),
 ('F-NARROW', F, 1, 2511),
 ('F-REACH', F, 2513, 2652),
 ('F-NARROW', F, 2654, 2764),
]
ORDER = ['E-CORE', 'E-LITERAL', 'E-OPER', 'E-ACCESS', 'E-FACTS', 'E-FUNC', 'T-RETINFER', 'E-CALL', 'E-CTX', 'F-NARROW', 'F-REACH', 'F-UNREACH']
PRINTER = set('printer.go nodebuilder.go nodebuilder_hover.go nodebuilderimpl.go nodebuilderscopes.go nodecopy.go pseudotypenodebuilder.go symbolaccessibility.go symboltracker.go stringer_generated.go'.split())
# Steps of typecheck.md K3, in order. A zone that is not named here is LATER (its name is the Rust file of the split).
STEPS = [
 ['TYPES', 'LINKS', 'MAPPER'], ['UTIL'], ['T-KEYS', 'K-OBJ'], ['T-RSTACK'], ['C-INIT'], ['S-MERGE', 'D-SINK'],
 ['N-RESOLVE', 'N-DIAG'], ['A-ALIAS', 'M-MODULE', 'Q-ENTITY'], ['K-LIT', 'K-PRED', 'K-GENERIC', 'K-UNION', 'K-INTERSECT'],
 ['T-TUPLE'], ['T-DECLARED', 'T-ENUMVAL'], ['T-TYPENODE'], ['T-CONSTRAINT'], ['T-BASE'], ['T-MEMBERS', 'T-UIMEMBERS'],
 ['T-LOOKUP'], ['T-APPARENT'], ['T-SIGDECL', 'T-SIGSHAPE', 'T-SIGINST'], ['T-INSTANTIATE'], ['T-SYMTYPE'], ['T-WIDEN'],
 ['P-PRINTER'], ['R-REL', 'R-SIGREL', 'R-VARIANCE', 'R-DISCRIM'], ['R-ELAB'],
 ['E-CORE'], ['E-LITERAL'], ['E-OPER'], ['E-ACCESS'], ['E-FACTS'], ['E-FUNC'], ['T-RETINFER'], ['E-CALL'],
 ['I-INFER', 'I-REVMAP'], ['E-CTX'], ['F-NARROW'], ['F-REACH'],
 ['K-KEYOF', 'K-INDEXED', 'K-SUBST', 'K-COND', 'T-MAPPED', 'K-TEMPLATE', 'K-IMPORTTYPE'],
]
RANK = {}
for i, names in enumerate(STEPS):
    for n in names: RANK[n] = i + 1
LATER_RANK = len(STEPS) + 1
RANK['F-UNREACH'] = LATER_RANK + 4
RANK['binder'] = 0; RANK['referenceresolver'] = 0; RANK['tracer'] = 0
SPLIT = []
for line in open(CORE_SCRATCH + '/data/split.tsv'):
    p = line.rstrip('\n').split('\t')
    if len(p) >= 5 and '-' in p[1]:
        a, b = p[1].split('-'); SPLIT.append((int(a), int(b), p[4].replace('.rs', '')))
def chunk(file, line):
    if file != C: return file.split('/')[-1][:-3]
    for a, b, n in SPLIT:
        if a <= line <= b: return n
    return 'c??'
def in_ranges(rs, file, line):
    for n, fl, a, b in rs:
        if fl == file and a <= line <= b: return n
    return None
FNS = os.environ.get('ECF1B_FNS', '/tmp/k3a/fns.json')
fns = json.load(open(FNS))
# The call graph is the one of checker-core-scratch/goanal (name "pkg.Recv.func", decl, callees as names, fields, closures).
for f in fns:
    if 'recv' in f:
        f['q'] = (f['recv'].lstrip('*').split('[')[0] + '.' if f['recv'] else '') + f['name']
        f['decl'] = f['start']
        f['fields'] = f.get('cfields')
        f['closures'] = f.get('funclits') or 0
        f['callees'] = [c for c in (f.get('callees') or [])]
        f['diags'] = [d['text'] if isinstance(d, dict) else d for d in (f.get('diags') or [])]
    else:
        f['q'] = f['name'][len(f['pkg']) + 1:]
        f['callees'] = [{'pkg': c.split('.')[0], 'name': c.split('.', 1)[1], 'call': True} for c in (f.get('callees') or [])]
    for k in ('diags', 'panics', 'asserts', 'maprange', 'program', 'tracer', 'fields'):
        if f.get(k) is None: f[k] = []
    f['cfields'] = f['fields']
byname = {}
for f in fns:
    e = in_ranges(CORE, f['file'], f['decl']) or in_ranges(TYPEL, f['file'], f['decl']) or in_ranges(REL, f['file'], f['decl'])
    m = in_ranges(MINE, f['file'], f['decl'])
    f['claimed'] = e if (e and m) else None
    if e: f['zone'] = e
    elif m: f['zone'] = m
    elif f['file'].startswith('checker/') and f['file'].split('/')[-1] in PRINTER: f['zone'] = 'P-PRINTER'
    else: f['zone'] = chunk(f['file'], f['decl'])
    f['mine'] = f['zone'] in ORDER
    f['rank'] = RANK.get(f['zone'], LATER_RANK)
    f['chunk'] = chunk(f['file'], f['decl'])
    byname[(f['pkg'], f['q'])] = f
def short(f): return f['q'].replace('Checker.', 'c.')
def loc(f): return '%s:%d-%d' % (f['file'].split('/')[-1], f['decl'], f['end'])
def mine(L): return sorted([f for f in fns if f['zone'] == L], key=lambda f: (f['file'] != C, f['decl']))
def target(c): return byname.get((c['pkg'], c['name']))
def codes():
    out = {}
    for l in open(REF + 'diagnostics/diagnostics_generated.go', encoding='utf-8'):
        m = re.match(r'^var (\w+) = &Message\{code: (\d+), category: Category(\w+),', l)
        if m: out[m.group(1)] = (int(m.group(2)), m.group(3))
    return out
