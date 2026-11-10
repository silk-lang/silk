from pathlib import Path
import re
p=Path('.scratch/coarse-cache-experiment/compiler/src/main.silk');s=p.read_text()
# Cache implementations retain an injectable filesystem; only the CLI separates their
# disposable files from authored filesystem observations used for whole-artifact reuse.
names=['SemanticCache.'+n for n in ['settle','prefetch','openPrefetched','saveDetached','storePacks','saveParsed','openImports','saveImports','rememberRuntime']]+['CodegenCache.'+n for n in ['place','linkedBy','forgetLink','prune','recordLink','stamped']]+['cliHistorySeen','cliHistoryRemember']
edits=[];functions=set()
for name in names:
 for m in re.finditer(r'run '+re.escape(name)+r'\(',s):
  pos=m.end();depth=1;quoted=False
  while depth:
   c=s[pos]
   if c=='"' and s[pos-1]!='\\':quoted=not quoted
   if not quoted:
    if c=='(':depth+=1
    elif c==')':depth-=1
   pos+=1
  edits.append((pos,' |> Effect.provideMut<FileSystem>(&mut cacheFiles)'))
  starts=list(re.finditer(r'^(?:pub )?effect fn \w+\(',s[:m.start()],re.M));start=starts[-1].start();brace=s.index('{',start);functions.add(brace+1)
for pos in functions:edits.append((pos,'\n  // Cache I/O is not a language input, regardless of where authored inputs live.\n  let mut cacheFiles = run MachineFileSystem.make()'))
for pos,value in sorted(edits,reverse=True):s=s[:pos]+value+s[pos:]
s=s.replace('    // Clang fills the codegen cache after the build looked for its objects; recorded, the next run\n    // would find them changed and build once more.\n    let units = run CodegenCache.directoryFor(output)\n    run BuildInputs.exclude(&mut recorder, &units)\n    run BuildInputs.exclude(&mut recorder, &run NativeCompile.directoryFor(output))\n','')
start=s.index('    // The caches beside the artifact are the build\'s own, and the record checks the artifact by')
end=s.index('    run BuildInputs.exclude(&mut recorder, &path)',start)
s=s[:start]+'    // Cache providers bypass this recorder; no directory can hide authored inputs.\n'+s[end:]
s=s.replace('  // The build directory holds outputs and caches, never inputs.\n  run BuildInputs.exclude(&mut recorder, Projects.outputDirectory(project))\n','')
p.write_text(s)
print('isolated',len(edits)-len(functions),'cache calls across',len(functions),'CLI functions')
