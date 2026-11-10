from pathlib import Path
import re
import subprocess

ROOT = Path('/workspace/silk/.scratch/immutable-executable-bodies/compiler/src')
FILES = [ROOT/'main.silk'] + [ROOT/'semantic'/f'{name}.silk' for name in (
    'BorrowFieldCases', 'CallableResultCases', 'EmbeddedTextCases',
    'SemanticCallableCases', 'SemanticCaptureCases', 'SemanticCaseSupport',
    'SemanticConformanceCases', 'SemanticLoweringCases', 'SemanticStaticCases')]
LOGICAL = set('borrow references observes suspension parks releasesPackages nonParking accesses escapes'.split())
BODY = set('result parameters locals blocks externs contexts traps cancels features inlining optimizeSize frame lines variables'.split())

def masked(s):
    # Preserve positions; exclude authored source fixtures, literals and comments.
    return re.sub(r'"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/',
                  lambda m: ''.join('\n' if c == '\n' else ' ' for c in m[0]), s)

for path in FILES:
    s = subprocess.check_output(["git", "show", "572bb4bb420bf4dd1f152dbf647f2f790dfca48f:"+str(path.relative_to(ROOT.parent.parent))], cwd=ROOT.parent.parent, text=True)
    mask = masked(s)
    stack = []
    ends = {}
    enclosing = {}
    for i, c in enumerate(mask):
        enclosing[i] = stack[-1] if stack else None
        if c == '{': stack.append(i)
        if c == '}': ends[stack.pop()] = i
    scopes = []  # name, start, end, draft
    def add(name, start, end, draft=False): scopes.append((name, start, end, draft))
    def outer_end(pos):
        return ends[enclosing[pos]]
    edits = []
    # Explicit parameter types; the next body brace follows the signature.
    for m in re.finditer(r'(\w+): &(mut )?MirFunction\b', mask):
        begin = mask.index('{', m.end())
        add(m[1], begin, ends[begin], bool(m[2]))
    # Each successful arena lookup gets a local borrowed view for existing helpers.
    pattern = r'if let Option<&MirFunction>\.Some \{value: (\w+)\} = move [^\n]*? \{'
    for m in re.finditer(pattern, mask):
        begin = m.end()-1
        name = m[1]
        add(name, begin, ends[begin])
        binding = s[m.start():m.end()].replace('value: '+name, 'value: '+name+'View')
        indent = re.search(r'(^|\n)( *)[^\n]*$', s[:m.start()])[2]
        edits.append((m.start(), m.end(), binding+'\n'+indent+'  let '+name+' = &'+name+'View'))
    # Match-based lookups keep the owned view live beside the borrowed accessor.
    for m in re.finditer(r'let (\w+) = match move [^\n]*?\{ Option<&MirFunction>\.Some', mask):
        begin = mask.index('{', m.start())
        end = ends[begin]+1
        name = m[1]
        add(name, end, outer_end(m.start()))
        indent = re.search(r'(^|\n)( *)[^\n]*$', s[:m.start()])[2]
        edits.append((m.start(), m.start()+len('let '+name), 'let '+name+'View'))
        edits.append((end, end, '\n'+indent+'let '+name+' = &'+name+'View'))
    # Owned fixtures remain explicitly mutable drafts.
    for m in re.finditer(r'let (?:mut )?(\w+) = run (?:copyMirShape|recipeControlMir)\(', mask):
        add(m[1], m.end(), outer_end(m.start()), True)
    for m in re.finditer(r'if let Option<MirFunction>\.Some \{value: (\w+)\} = move \w+ \{', mask):
        add(m[1], m.end()-1, ends[m.end()-1], True)
    # A bare view argument is borrowed; a draft is viewed at read-only boundaries.
    for m in re.finditer(r'&(\w+)(?:\.\*)?(?=\s*[,\)])', mask):
        candidates = [sc for sc in scopes if sc[0] == m[1] and sc[1] <= m.start() < sc[2]]
        if candidates and max(candidates, key=lambda sc: sc[1])[3]:
            edits.append((m.start(), m.end(), '&MirDraft.view(&'+m[1]+')'))
    for m in re.finditer(r'\b(\w+)\.(\w+)\b', mask):
        name, field = m[1], m[2]
        candidates = [sc for sc in scopes if sc[0] == name and sc[1] <= m.start() < sc[2]]
        if not candidates: continue
        scope = max(candidates, key=lambda sc: sc[1])
        group = 'logical' if field in LOGICAL else 'body' if field in BODY else None
        if group:
            edits.append((m.start(), m.end(), name+'.'+group+'.'+field))
        elif field == 'key' and not scope[3] and s[m.start()-1:m.start()] == '&':
            edits.append((m.start()-1, m.start(), ''))
    for start, end, value in sorted(edits, reverse=True): s = s[:start]+value+s[end:]
    s = s.replace('Option<&MirFunction>', 'Option<MirView>')
    s = s.replace('&mut MirFunction', '&mut MirDraft').replace('&MirFunction', '&MirView')
    s = s.replace('Option<MirFunction>', 'Option<MirDraft>').replace('-> MirFunction', '-> MirDraft')
    # Imports and constructors are finished separately; no compatibility aliases.
    s = s.replace('MirFunction,', 'MirView, MirDraft, LogicalMir, ExecutableBody,').replace('{MirFunction}', '{MirView}')
    path.write_text(s)
    print(path.name, len(scopes), 'scopes', len(edits), 'edits')
