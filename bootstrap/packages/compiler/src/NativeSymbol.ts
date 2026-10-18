import type * as Target from './Target.js'

/** Preserves a foreign declaration's linker name without LLVM's C entry-point rewriting. */
export const foreign = (target: Target.Target, symbol: string): string =>
  target.architecture === 'wasm32' ? `\u0001${symbol}` : symbol
