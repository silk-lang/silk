import * as Effect from 'effect/Effect'
import type * as Backend from './Backend.js'
import { BackendError } from './Backend.js'
import type * as Mir from './Mir.js'
import * as NativeProgram from './NativeProgram.js'
import * as Target from './Target.js'

/** The bootstrap LLVM backend over the Silk LLVM builder. */
export const LlvmBackend: Backend.Backend<Backend.LlvmBitcodeArtifact> = {
  _tag: 'Backend',
  id: 'llvm',
  name: 'LLVM',
  targets: [...Target.native.map((target) => target.id), Target.wasm32UnknownUnknown.id],
  emit: Effect.fn('Backend.LLVM.emit')(function* (
    program: Mir.Module,
    request: Backend.CodegenRequest,
  ): Effect.fn.Return<Backend.LlvmBitcodeArtifact, BackendError> {
    const output = yield* NativeProgram.emit(program, request).pipe(
      Effect.catchTag('LlvmError', (cause) =>
        Effect.fail(
          new BackendError({
            operation: 'Backend.emit',
            backend: 'LLVM',
            message: `LLVM emission failed for ${program.module}`,
            reason: { _tag: 'WrappedFailure', cause },
          }),
        ),
      ),
    )
    const artifact = {
      _tag: 'LlvmBitcodeArtifact',
      support: request.support === true,
      backend: 'llvm',
      module: program.module,
      target: program.layout.target,
      symbols: output.symbols,
      nativeRuntimeSymbols: output.nativeRuntimeSymbols,
      runtimeFeatures: output.runtimeFeatures,
      foreignImports: output.foreignImports,
      foreignExports: output.foreignExports,
      foreignStatics: output.foreignStatics,
      bitcode: output.bitcode,
    }
    // Textual IR is rendered only when read: it is a full extra pass over the module and most
    // compiles (including the cached-artifact path) never look at it.
    let renderedIr: string | undefined
    Object.defineProperty(artifact, 'ir', {
      enumerable: true,
      get: () => {
        renderedIr ??= output.renderIr()
        return renderedIr
      },
    })
    return artifact as Backend.LlvmBitcodeArtifact
  }),
}
