// Round 62: buffered output (BufferedWriter, #2429) and bulk byte building (List.appendSlice,
// appendBytes, appendRepeated and Slice.copyInto, #2406): a padded table written through a
// BufferedWriter to a counting Writer and to standard output.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/bufout.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `bufout-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

const run = (dir, flags = []) => silk(h, ['run', '--quiet', ...flags], { cwd: dir })
const table = ['    0 |', '   37 |##', '   74 |####', '  111 |######', '  148 |#', '  185 |###', '  222 |#####', '  259 |', '  296 |##', '  333 |####', '  370 |######', '  407 |#'].join('\n') + '\n'

test('the bufout program prints its table and passes its checks', () => {
  const result = run(variant())
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, table, show(result))
})

test('the bufout program gives the same table in a release build', () => {
  const result = run(variant(), ['--release'])
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, table, show(result))
})

test('dropping a BufferedWriter without finish loses the pending bytes, as documented', () => {
  const result = run(variant('  let stdout = run BufferedWriter<StdoutWriter>.finish(move out)\n  drop stdout', '  drop out'))
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, '', show(result))
})

test('Slice.copyInto past the end traps with its reason at the caller', () => {
  const result = run(variant('  Slice.copyInto<u8>(&mut frame, 8, b"")', '  Slice.copyInto<u8>(&mut frame, 6, b"abc")'))
  assert.ok(result.signal === 'SIGILL' || result.status === 132, show(result))
  assert.match(result.stderr, /fatal trap: Slice\.copyInto: the source does not fit at offset\n\s+at main\.body/, show(result))
})

test('a zero capacity is a BufferError the handler sees', () => {
  const result = run(variant('StdoutWriter.make(), 4096)', 'StdoutWriter.make(), 0)'))
  assert.equal(result.status, 10, show(result))
})

test('appendSlice of a non-Copy element names Copy', () => {
  const result = silk(h, ['check'], { cwd: variant('  return 0\n}\n\neffect fn recover', '  let mut names = List<List<u8>>.make()\n  let none: [List<u8>; 0] = []\n  run List<List<u8>>.appendSlice(&mut names, &none)\n  return 0\n}\n\neffect fn recover') })
  assert.match(result.stderr, /SEM0121\] `silk\.list\.List<u8>: Copy` cannot be proved/, show(result))
})

// Finding 178: with the default writeVectored, a write that does not fit the space left is a
// second destination write, so 200 rows through 256 bytes take about 17 writes, not 9.
test('a Writer without writeVectored gets one destination write per buffer fill', { todo: 'finding 178' }, () => {
  const start = program.indexOf('  // One destination write')
  const end = program.indexOf('  effect fn flush')
  const result = run(variant(program.slice(start, end), ''))
  assert.equal(result.status, 0, show(result))
})
