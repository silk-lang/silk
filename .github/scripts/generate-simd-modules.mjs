#!/usr/bin/env node
// Writes the per-shape SIMD modules under stdlib/silk/simd from one table, so every shape has the
// same operations and documentation. Run it after changing a shape or an operation:
//
//   node .github/scripts/generate-simd-modules.mjs
//
// `--check` exits non-zero when a generated file differs from the checked-in one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../../stdlib/silk/simd/', import.meta.url)
const check = process.argv.includes('--check')

const lanes = {
  u8: { bits: 8, kind: 'unsigned', word: 'unsigned 8-bit integer' },
  i8: { bits: 8, kind: 'signed', word: 'signed 8-bit integer' },
  u16: { bits: 16, kind: 'unsigned', word: 'unsigned 16-bit integer' },
  i16: { bits: 16, kind: 'signed', word: 'signed 16-bit integer' },
  u32: { bits: 32, kind: 'unsigned', word: 'unsigned 32-bit integer' },
  i32: { bits: 32, kind: 'signed', word: 'signed 32-bit integer' },
  u64: { bits: 64, kind: 'unsigned', word: 'unsigned 64-bit integer' },
  i64: { bits: 64, kind: 'signed', word: 'signed 64-bit integer' },
  f32: { bits: 32, kind: 'float', word: '32-bit float' },
  f64: { bits: 64, kind: 'float', word: '64-bit float' },
}
const widths = [128, 256]
const counts = { 2: 'two', 4: 'four', 8: 'eight', 16: 'sixteen', 32: 'thirty-two' }

const shapes = []
for (const width of widths) {
  for (const [lane, info] of Object.entries(lanes)) {
    const count = width / info.bits
    shapes.push({ lane, count, width, ...info, name: `${lane}x${count}`, type: `simd<${lane}, ${count}>` })
  }
}
const maskCounts = [...new Set(shapes.map((shape) => shape.count))].sort((a, b) => a - b)

const upper = (name) => name[0].toUpperCase() + name.slice(1)
const literal = (shape, value) => (shape.kind === 'float' ? `${value}.0` : `${value}`)

const files = new Map()

for (const shape of shapes) {
  const { lane, count, type, name } = shape
  const mask = `mask<${count}>`
  const maskModule = `mask${count}`
  const integer = shape.kind !== 'float'
  const out = []
  const doc = (text) => out.push(...text.split('\n').map((line) => (line ? `/// ${line}` : '///')))
  const fn = (comment, signature, body) => {
    out.push('')
    doc(comment)
    out.push(`${signature} {`)
    out.push(`  ${body}`)
    out.push('}')
  }
  const unsafeFn = (comment, signature, body) => {
    out.push('')
    doc(comment)
    out.push(`${signature} {`)
    out.push(`  unsafe { ${body} }`)
    out.push('}')
  }

  out.push(`//! Operations on \`${type}\`: ${counts[count]} ${shape.word} lanes in one ${shape.width}-bit vector.`)
  out.push('//!')
  out.push('//! # When to use')
  out.push(`//! Use this module to work on ${counts[count]} \`${lane}\` values at once. Use [\`load\`] and [\`store\`]`)
  out.push('//! to move lanes between a slice and a vector, a lane comparison such as [`lanesEqual`] to make')
  out.push(`//! a \`${mask}\`, and \`silk.simd.${maskModule}\` to test that mask.`)
  out.push('//!')
  out.push('//! # Details')
  if (integer) {
    out.push('//! The operators `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^` and `~` apply lane by lane and trap')
    out.push(`//! exactly where the \`${lane}\` operator traps. Use [\`wrappingAdd\`] or [\`saturatingAdd\`] when`)
    out.push('//! overflow is expected. `==` is true only when every lane is equal.')
  } else {
    out.push('//! The operators `+`, `-`, `*`, `/` and `%` apply lane by lane and follow IEEE 754 as the')
    out.push(`//! \`${lane}\` operators do. \`==\` is true only when every lane is equal, and a NaN lane is never`)
    out.push('//! equal. [`reduceAdd`] adds lanes in order, so it gives the same result on every target.')
  }
  out.push('//! Lane `0` is at the lowest address in memory.')
  out.push('//!')
  out.push('//! # Examples')
  if (integer) {
    const wanted = shape.kind === 'signed' ? -3 : 3
    out.push('//! ## Find the first matching lane')
    out.push('//! ```silk')
    out.push(`//! import silk.simd.${maskModule}`)
    out.push(`//! import silk.simd.${name}`)
    out.push('//!')
    out.push('//! pub fn main() -> i32 {')
    out.push(`//!   let mut values: [${lane}; ${count}] = ${name}.toArray(${name}.splat(0))`)
    out.push(`//!   values[${count - 1}] = ${wanted}`)
    out.push(`//!   let hits = ${name}.lanesEqual(${name}.fromArray(values), ${name}.splat(${wanted}))`)
    out.push(`//!   if !${maskModule}.any(hits) || ${maskModule}.firstSet(hits) != ${count - 1} {`)
    out.push('//!     return 1')
    out.push('//!   }')
    out.push('//!   return 0')
    out.push('//! }')
    out.push('//! ```')
  } else {
    const values = Array.from({ length: count }, (_, at) => at + 1)
    const total = values.reduce((sum, value) => sum + value * 2, 0)
    out.push('//! ## Scale every lane and add the results')
    out.push('//! ```silk')
    out.push(`//! import silk.simd.${name}`)
    out.push('//!')
    out.push('//! pub fn main() -> i32 {')
    out.push(`//!   let values = ${name}.fromArray([${values.map((value) => literal(shape, value)).join(', ')}])`)
    out.push(`//!   let doubled = ${name}.mulAdd(values, ${name}.splat(2.0), ${name}.splat(0.0))`)
    out.push(`//!   if ${name}.reduceAdd(doubled) != ${literal(shape, total)} {`)
    out.push('//!     return 1')
    out.push('//!   }')
    out.push('//!   return 0')
    out.push('//! }')
    out.push('//! ```')
  }
  out.push('')
  out.push(`// Generated by .github/scripts/generate-simd-modules.mjs; edit the script, not this file.`)
  out.push('')
  out.push('/// The number of lanes in a vector.')
  out.push(`pub const LANES: usize = ${count}`)

  fn('Returns a vector with every lane set to `lane`.', `pub fn splat(lane: ${lane}) -> ${type}`,
    `return Intrinsic.simdSplat<${type}>(lane)`)
  fn('Returns a vector whose lane `i` is `lanes[i]`.', `pub fn fromArray(lanes: [${lane}; ${count}]) -> ${type}`,
    `return Intrinsic.simdFromArray<${type}>(lanes)`)
  fn('Returns the lanes of `vector` as an array, in lane order.', `pub fn toArray(vector: ${type}) -> [${lane}; ${count}]`,
    `return Intrinsic.simdToArray<${type}>(vector)`)
  fn('Returns lane `index` of `vector`. Traps when `index` is [`LANES`] or more.',
    `pub fn extract(vector: ${type}, index: usize) -> ${lane}`, `return Intrinsic.simdExtract<${type}>(vector, index)`)
  fn('Returns `vector` with lane `index` replaced by `lane`. Traps when `index` is [`LANES`] or more.',
    `pub fn insert(vector: ${type}, index: usize, lane: ${lane}) -> ${type}`,
    `return Intrinsic.simdInsert<${type}>(vector, index, lane)`)
  fn(`Reads [\`LANES\`] lanes of \`lanes\` starting at \`offset\`.\n\n# Gotchas\nTraps unless \`offset + LANES\` is at most \`lanes.length\`. The slice needs no alignment beyond\n\`${lane}\`.`,
    `pub fn load(lanes: &[${lane}], offset: usize) -> ${type}`, `return Intrinsic.simdLoad<${type}>(lanes, offset)`)
  fn('Writes the lanes of `vector` into `lanes` starting at `offset`.\n\n# Gotchas\nTraps unless `offset + LANES` is at most `lanes.length`.',
    `pub fn store(lanes: &mut [${lane}], offset: usize, vector: ${type}) -> ()`,
    `return Intrinsic.simdStore<${type}>(&mut lanes, offset, vector)`)
  unsafeFn(`Reads [\`LANES\`] lanes starting at \`pointer\`, with no bounds check.\n\n# Gotchas\nThe caller proves that \`pointer\` addresses [\`LANES\`] live lanes aligned to \`${lane}\`.`,
    `pub unsafe fn loadUnchecked(pointer: [*]const ${lane}) -> ${type}`, `return Intrinsic.simdPointerLoad<${type}>(pointer)`)
  unsafeFn(`Writes the lanes of \`vector\` starting at \`pointer\`, with no bounds check.\n\n# Gotchas\nThe caller proves that \`pointer\` addresses [\`LANES\`] writable lanes aligned to \`${lane}\`.`,
    `pub unsafe fn storeUnchecked(pointer: [*]mut ${lane}, vector: ${type}) -> ()`,
    `return Intrinsic.simdPointerStore<${type}>(pointer, vector)`)

  const comparisons = [
    ['lanesEqual', 'LanesEqual', 'equal to'],
    ['lanesNotEqual', 'LanesNotEqual', 'not equal to'],
    ['lanesLess', 'LanesLess', 'less than'],
    ['lanesLessOrEqual', 'LanesLessOrEqual', 'less than or equal to'],
    ['lanesGreater', 'LanesGreater', 'greater than'],
    ['lanesGreaterOrEqual', 'LanesGreaterOrEqual', 'greater than or equal to'],
  ]
  for (const [method, intrinsic, words] of comparisons) {
    let comment = `Returns a mask with lane \`i\` set where lane \`i\` of \`left\` is ${words} lane \`i\` of \`right\`.`
    if (!integer && method === 'lanesNotEqual') comment += ' A NaN lane is\nnot equal to any lane.'
    else if (!integer) comment += ' A comparison with a\nNaN lane is false.'
    fn(comment, `pub fn ${method}(left: ${type}, right: ${type}) -> ${mask}`,
      `return Intrinsic.simd${intrinsic}<${type}>(left, right)`)
  }
  fn('Returns lane `i` of `chosen` where lane `i` of `mask` is set, and lane `i` of `other` elsewhere.',
    `pub fn select(mask: ${mask}, chosen: ${type}, other: ${type}) -> ${type}`,
    `return Intrinsic.simdSelect<${type}>(mask, chosen, other)`)
  const nan = integer ? '' : ' A NaN lane in either input gives NaN, and `-0.0` is\nless than `0.0`.'
  fn(`Returns the smaller lane of each pair.${nan}`, `pub fn minimum(left: ${type}, right: ${type}) -> ${type}`,
    `return Intrinsic.simdMinimum<${type}>(left, right)`)
  fn(`Returns the larger lane of each pair.${nan}`, `pub fn maximum(left: ${type}, right: ${type}) -> ${type}`,
    `return Intrinsic.simdMaximum<${type}>(left, right)`)
  fn(`Returns a vector whose lane \`i\` is lane \`indices[i]\` of \`left\` followed by \`right\`.\n\n# Details\nAn index below [\`LANES\`] selects from \`left\`, and an index from [\`LANES\`] to \`2 * LANES - 1\`\nselects from \`right\`. The indices are static, so each call is one fixed lane permutation.`,
    `pub fn shuffle(left: ${type}, right: ${type}, static indices: [usize; ${count}]) -> ${type}`,
    `return Intrinsic.simdShuffle<${type}, ${type}>(left, right, indices)`)

  if (integer) {
    fn('Returns the sum of every lane. Traps when the exact sum does not fit `' + lane + '`.',
      `pub fn reduceAdd(vector: ${type}) -> ${lane}`, `return Intrinsic.simdReduceAdd<${type}>(vector)`)
  } else {
    fn('Returns the sum of every lane, added in lane order from lane `0`.',
      `pub fn reduceAdd(vector: ${type}) -> ${lane}`, `return Intrinsic.simdReduceAdd<${type}>(vector)`)
    fn('Returns the sum of every lane, added in the order the target prefers.\n\n# Gotchas\nThe rounding can differ between targets. Use [`reduceAdd`] for a result that is the same\neverywhere.',
      `pub fn reduceAddUnordered(vector: ${type}) -> ${lane}`, `return Intrinsic.simdReduceAddUnordered<${type}>(vector)`)
  }
  fn(`Returns the smallest lane.${nan ? ' A NaN lane gives NaN.' : ''}`, `pub fn reduceMinimum(vector: ${type}) -> ${lane}`,
    `return Intrinsic.simdReduceMinimum<${type}>(vector)`)
  fn(`Returns the largest lane.${nan ? ' A NaN lane gives NaN.' : ''}`, `pub fn reduceMaximum(vector: ${type}) -> ${lane}`,
    `return Intrinsic.simdReduceMaximum<${type}>(vector)`)

  if (integer) {
    for (const [method, words] of [['Add', 'sum'], ['Subtract', 'difference'], ['Multiply', 'product']]) {
      fn(`Returns the ${words} of each pair of lanes modulo 2^${shape.bits}.`,
        `pub fn wrapping${method}(left: ${type}, right: ${type}) -> ${type}`,
        `return Intrinsic.simdWrapping${method}<${type}>(left, right)`)
    }
    for (const [method, words] of [['Add', 'sum'], ['Subtract', 'difference']]) {
      fn(`Returns the ${words} of each pair of lanes, clamped to the range of \`${lane}\`.`,
        `pub fn saturating${method}(left: ${type}, right: ${type}) -> ${type}`,
        `return Intrinsic.simdSaturating${method}<${type}>(left, right)`)
    }
    const right = shape.kind === 'signed' ? 'copies the sign bit' : 'inserts zero bits'
    fn(`Shifts lane \`i\` of \`vector\` left by lane \`i\` of \`counts\`.\n\n# Gotchas\nTraps when any count is not in the range 0 to ${shape.bits - 1}.`,
      `pub fn shiftLeft(vector: ${type}, counts: ${type}) -> ${type}`, `return Intrinsic.simdShiftLeft<${type}>(vector, counts)`)
    fn(`Shifts lane \`i\` of \`vector\` right by lane \`i\` of \`counts\`. The shift ${right}.\n\n# Gotchas\nTraps when any count is not in the range 0 to ${shape.bits - 1}.`,
      `pub fn shiftRight(vector: ${type}, counts: ${type}) -> ${type}`, `return Intrinsic.simdShiftRight<${type}>(vector, counts)`)
    fn(`Rotates lane \`i\` of \`vector\` left by lane \`i\` of \`counts\` modulo ${shape.bits}.`,
      `pub fn rotateLeft(vector: ${type}, counts: ${type}) -> ${type}`, `return Intrinsic.simdRotateLeft<${type}>(vector, counts)`)
    fn(`Rotates lane \`i\` of \`vector\` right by lane \`i\` of \`counts\` modulo ${shape.bits}.`,
      `pub fn rotateRight(vector: ${type}, counts: ${type}) -> ${type}`, `return Intrinsic.simdRotateRight<${type}>(vector, counts)`)
    fn(`Returns the sum of every lane modulo 2^${shape.bits}.`, `pub fn reduceWrappingAdd(vector: ${type}) -> ${lane}`,
      `return Intrinsic.simdReduceWrappingAdd<${type}>(vector)`)
    for (const [method, words] of [['BitAnd', 'bitwise and'], ['BitOr', 'bitwise or'], ['BitXor', 'bitwise exclusive or']]) {
      fn(`Returns the ${words} of every lane.`, `pub fn reduce${method}(vector: ${type}) -> ${lane}`,
        `return Intrinsic.simdReduce${method}<${type}>(vector)`)
    }
  } else {
    fn('Returns the square root of each lane. A negative lane gives NaN.', `pub fn sqrt(vector: ${type}) -> ${type}`,
      `return Intrinsic.simdSqrt<${type}>(vector)`)
    fn('Returns `left * right + addend` for each lane, with one rounding.',
      `pub fn mulAdd(left: ${type}, right: ${type}, addend: ${type}) -> ${type}`,
      `return Intrinsic.simdMulAdd<${type}>(left, right, addend)`)
  }

  for (const other of shapes) {
    if (other === shape || other.count !== count) continue
    let comment = `Converts each lane to \`${other.lane}\` as the scalar conversion does.`
    if (other.kind !== 'float') comment += ' Traps when any lane does not\nfit `' + other.lane + '`.'
    fn(comment, `pub fn to${upper(other.name)}(vector: ${type}) -> ${other.type}`,
      `return Intrinsic.simdConvert<${type}, ${other.type}>(vector)`)
  }
  for (const other of shapes) {
    if (other === shape || other.width !== shape.width) continue
    fn(`Returns the bits of \`vector\` as a \`${other.type}\`, in memory order.`,
      `pub fn bitcastTo${upper(other.name)}(vector: ${type}) -> ${other.type}`,
      `return Intrinsic.simdBitcast<${type}, ${other.type}>(vector)`)
  }
  files.set(`${name}.silk`, out.join('\n') + '\n')
}

for (const count of maskCounts) {
  const type = `mask<${count}>`
  const name = `mask${count}`
  const out = []
  const fn = (comment, signature, body) => {
    out.push('')
    out.push(...comment.split('\n').map((line) => (line ? `/// ${line}` : '///')))
    out.push(`${signature} {`)
    out.push(`  ${body}`)
    out.push('}')
  }
  const example = Array.from({ length: count }, (_, at) => (at % 2 === 1 ? 'true' : 'false'))
  let bits = 0n
  for (let at = 1; at < count; at += 2) bits |= 1n << BigInt(at)
  out.push(`//! Operations on \`${type}\`: ${counts[count]} lanes that are each set or clear.`)
  out.push('//!')
  out.push('//! # When to use')
  out.push('//! A lane comparison in a vector module returns a mask. Use [`any`] or [`all`] to branch on it,')
  out.push('//! [`firstSet`] to find the first matching lane, and [`toBits`] to process every set lane.')
  out.push('//!')
  out.push('//! # Details')
  out.push('//! The operators `&`, `|`, `^`, `~` and `!` apply lane by lane. `==` is true only when every lane')
  out.push('//! is equal. In [`toBits`], lane `i` is bit `i`.')
  out.push('//!')
  out.push('//! # Examples')
  out.push('//! ## Count and locate set lanes')
  out.push('//! ```silk')
  out.push(`//! import silk.simd.${name}`)
  out.push('//!')
  out.push('//! pub fn main() -> i32 {')
  out.push(`//!   let flags = ${name}.fromArray([${example.join(', ')}])`)
  out.push(`//!   if ${name}.count(flags) != ${count / 2} || ${name}.firstSet(flags) != 1 || ${name}.toBits(flags) != ${bits} {`)
  out.push('//!     return 1')
  out.push('//!   }')
  out.push('//!   return 0')
  out.push('//! }')
  out.push('//! ```')
  out.push('')
  out.push(`// Generated by .github/scripts/generate-simd-modules.mjs; edit the script, not this file.`)
  out.push('')
  out.push('/// The number of lanes in a mask.')
  out.push(`pub const LANES: usize = ${count}`)
  fn('Returns a mask with every lane set when `set` is true, and every lane clear otherwise.',
    `pub fn splat(set: bool) -> ${type}`, `return Intrinsic.simdSplat<${type}>(set)`)
  fn('Returns a mask whose lane `i` is set when `lanes[i]` is true.', `pub fn fromArray(lanes: [bool; ${count}]) -> ${type}`,
    `return Intrinsic.simdFromArray<${type}>(lanes)`)
  fn('Returns the lanes of `mask` as an array, in lane order.', `pub fn toArray(mask: ${type}) -> [bool; ${count}]`,
    `return Intrinsic.simdToArray<${type}>(mask)`)
  fn('Returns whether lane `index` of `mask` is set. Traps when `index` is [`LANES`] or more.',
    `pub fn extract(mask: ${type}, index: usize) -> bool`, `return Intrinsic.simdExtract<${type}>(mask, index)`)
  fn('Returns `mask` with lane `index` set when `set` is true and clear otherwise. Traps when `index` is\n[`LANES`] or more.',
    `pub fn insert(mask: ${type}, index: usize, set: bool) -> ${type}`, `return Intrinsic.simdInsert<${type}>(mask, index, set)`)
  fn('Returns whether at least one lane is set.', `pub fn any(mask: ${type}) -> bool`, `return Intrinsic.simdMaskAny<${type}>(mask)`)
  fn('Returns whether every lane is set.', `pub fn all(mask: ${type}) -> bool`, `return Intrinsic.simdMaskAll<${type}>(mask)`)
  fn('Returns the number of set lanes.', `pub fn count(mask: ${type}) -> usize`, `return Intrinsic.simdMaskCount<${type}>(mask)`)
  fn('Returns the index of the lowest set lane, or [`LANES`] when no lane is set.',
    `pub fn firstSet(mask: ${type}) -> usize`, `return Intrinsic.simdMaskFirstSet<${type}>(mask)`)
  fn('Returns the lanes as bits: bit `i` is set when lane `i` is set. Bits from [`LANES`] up are zero.',
    `pub fn toBits(mask: ${type}) -> u64`, `return Intrinsic.simdMaskToBits<${type}>(mask)`)
  fn('Returns a mask whose lane `i` is set when bit `i` of `bits` is set. Bits from [`LANES`] up are\nignored.',
    `pub fn fromBits(bits: u64) -> ${type}`, `return Intrinsic.simdMaskFromBits<${type}>(bits)`)
  files.set(`${name}.silk`, out.join('\n') + '\n')
}

let stale = []
mkdirSync(root, { recursive: true })
for (const [file, text] of files) {
  const path = new URL(file, root)
  if (check) {
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch {}
    if (current !== text) stale.push(file)
  } else {
    writeFileSync(path, text)
  }
}
if (stale.length > 0) {
  console.error(`Stale SIMD modules: ${stale.join(', ')}. Run node .github/scripts/generate-simd-modules.mjs`)
  process.exit(1)
}
if (!check) console.log(`Wrote ${files.size} modules to stdlib/silk/simd`)
