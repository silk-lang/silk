/**
 * The native acceptance harness's work catalog and its only shard selection: native corpus cases,
 * fixed scenarios, and portable Wasm cases.
 */

/** A corpus entry identified by a unique name. */
export interface Named {
  readonly name: string
}

/** The work one native acceptance process may run, by category. */
export interface NativeWork<Native extends Named, Fixed extends string, Wasm extends Named> {
  readonly native: ReadonlyArray<Native>
  readonly fixed: ReadonlyArray<Fixed>
  readonly wasm: ReadonlyArray<Wasm>
}

/** One 1-based shard of a `count`-way split. */
export interface Shard {
  readonly index: number
  readonly count: number
}

/** What one process was asked to run. */
export interface Request {
  /** `undefined` runs every shard's work. */
  readonly shard: Shard | undefined
  /** Whether fixed scenarios run, and whether Wasm cases run when `cases` is empty. */
  readonly fixed: boolean
  /** Requested native or Wasm case names; empty selects every case. */
  readonly cases: ReadonlySet<string>
}

/** Parses `k/n` with `1 <= k <= n`; anything else, including the empty string, is `undefined`. */
export const parseShard = (text: string): Shard | undefined => {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text)
  if (match === null) return undefined
  const index = Number(match[1])
  const count = Number(match[2])
  return index <= count ? { index, count } : undefined
}

/**
 * Deals native cases, then fixed scenarios, then Wasm cases round-robin across shards as one
 * sequence, so every shard receives a share of each category and the per-shard totals differ by at
 * most one item. Native cases keep their `index % count` assignment. Case names filter the native and
 * Wasm cases dealt to this shard; fixed scenarios ignore them.
 */
export const select = <Native extends Named, Fixed extends string, Wasm extends Named>(
  self: NativeWork<Native, Fixed, Wasm>,
  request: Request,
): NativeWork<Native, Fixed, Wasm> => {
  const { shard, cases } = request
  const dealt = (position: number): boolean =>
    shard === undefined || position % shard.count === shard.index - 1
  const requested = (name: string): boolean => cases.size === 0 || cases.has(name)
  const fixedStart = self.native.length
  const wasmStart = fixedStart + self.fixed.length
  return {
    native: self.native.filter((program, index) => dealt(index) && requested(program.name)),
    fixed: self.fixed.filter((_, index) => request.fixed && dealt(fixedStart + index)),
    wasm: self.wasm.filter(
      (program, index) =>
        dealt(wasmStart + index) && (cases.size === 0 ? request.fixed : cases.has(program.name)),
    ),
  }
}
