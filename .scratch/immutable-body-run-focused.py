import os, pathlib, subprocess, sys
base=pathlib.Path('/workspace/silk/.scratch')
filters=['releasedMirSlotsPreserveLiveRequestBodies','selectedRuntimeExportsAreTheBuildRoots','cStructWasmMachineSignatures','genericEqualLifetimeRecipesShareOneBody','genericRecipe','useAfterDropReportsAMisplacedTemporaryDrop','simpleLocalsGetStackLifetimeMarkers','stackLifetimesCoverTerminatorOperands','scalarTemporaryStorage','parameterValues','hiddenIncomingValuesRetainWritesAndAddressExposures']
for name in filters:
 command=[str(base/'ci-n1-4a1fa332/N1'),'test','compiler/src/semantic/SemanticLoweringCases.silk','--stdlib','stdlib','--optimization','none','--debug','false','--output',str(base/'immutable-body-liveness-test'),'--filter',name]
 with (base/f'immutable-body-focused-{name}.log').open('w') as log:
  result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
 print(name,result.returncode,flush=True)
 if result.returncode: sys.exit(result.returncode)
