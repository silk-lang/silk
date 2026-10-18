/** Spelling and reservation rules for the native symbol named by a foreign function. */

/** Private generated symbols; platform entry names belong to selected source exports. */
export const reservedSymbols: ReadonlyArray<string> = ['__silk_foreign_personality']

/** Generated symbol shapes: suspension thunks and `silk_<module>_<name>__<instance>`. */
export const reservedPatterns: ReadonlyArray<RegExp> = [/^silk_suspend_/, /^silk_.*__/]

export const isValidSpelling = (symbol: string): boolean => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(symbol)

export const isReserved = (symbol: string): boolean =>
  reservedSymbols.includes(symbol) || reservedPatterns.some((pattern) => pattern.test(symbol))
