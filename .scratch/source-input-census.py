"""Read optional frontier input dumps; identities compare exact bytes, never hash-only."""
import argparse, collections, json
from pathlib import Path

class Reader:
    def __init__(self, data): self.data, self.at = data, 0
    def word(self):
        if self.at + 8 > len(self.data): raise ValueError('truncated word')
        value = int.from_bytes(self.data[self.at:self.at+8], 'big'); self.at += 8
        return value
    def field(self):
        size = self.word()
        if size > len(self.data)-self.at: raise ValueError('truncated field')
        value = self.data[self.at:self.at+size]; self.at += size
        return value

def read(path):
    r=Reader(path.read_bytes())
    if r.field()!=b'silk-input-census-v1': raise ValueError('unknown census format')
    worker, stamp, roots, leaves=r.word(),r.field(),r.word(),r.word()
    count=r.word()
    if count>(len(r.data)-r.at)//8: raise ValueError('invalid pending count')
    pending=[r.word() for _ in range(count)]
    if len(set(pending))!=len(pending): raise ValueError('duplicate pending input')
    count=r.word()
    if count>(len(r.data)-r.at)//48: raise ValueError('invalid input count')
    inputs=[]
    for _ in range(count):
        authored, facet, key=r.word(),r.word(),r.field()
        digest=(r.word(),r.word()); exported=r.word()
        if authored not in (0,1) or facet not in (0,1) or exported not in (0,1): raise ValueError('invalid flag')
        inputs.append(dict(authored=authored,facet=facet,key=key,digest=digest,exported=exported))
    if r.at!=len(r.data): raise ValueError('trailing bytes')
    if any(i>=count for i in pending): raise ValueError('pending input out of bounds')
    return dict(path=str(path),worker=worker,stamp=stamp,roots=roots,leaves=leaves,inputs=inputs,pending=pending)

def summarize(records):
    rows=[]; computed=collections.Counter(); facets=collections.Counter(); exported=collections.Counter(); observed=collections.defaultdict(set)
    for rec in records:
        pending=[rec['inputs'][i] for i in rec['pending']]
        rows.append(dict(path=rec['path'],worker=rec['worker'],roots=rec['roots'],image_input_leaves=rec['leaves'],observations=len(rec['inputs']),pending=len(pending),pending_declaration_facets=sum(x['facet'] for x in pending),pending_exported=sum(x['exported'] for x in pending),pending_unexported=sum(not x['exported'] for x in pending),unstable_pending=sum(not x['key'] for x in pending)))
        for item in pending:
            if not item['key']: continue
            identity=(item['key'],item['digest'])
            computed[identity]+=1; observed[item['key']].add(item['digest'])
            if item['facet']: facets[identity]+=1
            if item['exported']: exported[identity]+=1
    def stats(counter):
        return dict(computations=sum(counter.values()),unique_exact_key_and_value=len(counter),repeated_computations=sum(counter.values())-len(counter),keys_computed_by_multiple_dumps=sum(n>1 for n in counter.values()))
    return dict(workers=rows,pending=stats(computed),declaration_facets=stats(facets),exported_pending=stats(exported),same_key_different_values=sum(len(v)>1 for v in observed.values()),notes=['Pending IDs were captured immediately before worker cache assembly.','Exported means reachable from retained transport roots with the same exact stable input key and digest.','Counters are diagnostic; trace allocation and output make this unsuitable for timing comparisons.','Repeated computations are an upper bound on savings from a shared immutable memo; contention and transport costs are excluded.'])

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('files',nargs='+',type=Path);a=p.parse_args()
    records=[read(path) for path in a.files]
    if len({r['stamp'] for r in records})!=1: raise ValueError('mixed source/profile stamps; analyze one invocation at a time')
    print(json.dumps(summarize(records),indent=2))
