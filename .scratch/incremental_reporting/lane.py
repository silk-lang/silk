"""CPU affinity and prototype worker policy; no compiler construction settings."""
POLICIES=('parallel','serial','default')
def cpus(value):
    selected=set()
    for item in value.split(','):
        item=item.strip()
        if '-' in item:
            lo,hi=map(int,item.split('-',1))
            if lo<0 or hi<lo:raise ValueError('invalid CPU range')
            selected.update(range(lo,hi+1))
        else:
            n=int(item)
            if n<0:raise ValueError('negative CPU')
            selected.add(n)
    if not selected:raise ValueError('CPU list is empty')
    return sorted(selected)

def identity(selected):return 'cpus='+','.join(map(str,selected))

def candidate_environment(base, features, policy, mode, operation):
    env=dict(base);env.update(features)
    if policy!='default':
        # Keep cache/native/backend switches identical between prototype parallel and serial.
        env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
        if mode.startswith('ephemeral'):env['SILK_FRONTIER_EPHEMERAL']='1'
        if mode.endswith('-whole'):env['SILK_EXPERIMENT_WHOLE_CHECK']='1'
        if operation=='build':env.update(SILK_RETAINED_BUILD='1',SILK_EXPERIMENT_DEV_PACKS='1')
    if policy=='serial':
        # Presence enables the prototype. Setting this to "0" would still enable its pool.
        env.pop('SILK_EXPERIMENT_FRONTIER',None)
    return env

def expect_no_pool(policy, selected):return policy=='serial' or (policy=='default' and len(selected)==1)
