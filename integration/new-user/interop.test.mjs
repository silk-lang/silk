// Round 49: C interop beyond structs (reference Unsafe code and C interop): libc qsort and bsearch
// with export "C" comparators passed as C function pointers, div returning a C struct by value,
// variadic snprintf, and an exported static.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0
const program = read(join(here, 'programs/cffi.silk'))

function variant(from = '', to = '') {
  assert.ok(program.includes(from), `the program contains ${from}`)
  const dir = initPackage(h, `cffi-${++serial}`)
  write(join(dir, 'src/main.silk'), program.replace(from, to))
  return dir
}

test('the C interop program in programs/ runs and exits 0', () => {
  const result = silk(h, ['run'], { cwd: variant() })
  assert.equal(result.status, 0, show(result))
})

test('a foreign function declared without unsafe is SEM0186 naming it', () => {
  const result = silk(h, ['check'], { cwd: variant('unsafe extern "C" fn labs(value: i64) -> i64', 'extern "C" fn labs(value: i64) -> i64') })
  assert.match(result.stderr, /error\[SEM0186\] Foreign function labs must be declared unsafe/)
})

test('a bool result of a foreign function is not admitted by the C ABI', () => {
  const result = silk(h, ['check'], { cwd: variant('unsafe extern "C" fn labs(value: i64) -> i64', 'unsafe extern "C" fn labs(value: i64) -> bool') })
  assert.match(result.stderr, /error\[SEM0187\] bool is not admitted by the C ABI/)
})

test('calling an export "C" function from Silk inside unsafe builds', { todo: 'finding 160' }, () => {
  const result = silk(h, ['build'], { cwd: variant('  return order(left, right)', '  return unsafe descending(right, left)') })
  assert.equal(result.status, 0, show(result))
})

test('a foreign call without unsafe names the call and the fix', { todo: 'finding 161' }, () => {
  const result = silk(h, ['check'], { cwd: variant('  unsafe qsort(first, 6, 4, ascending)', '  qsort(first, 6, 4, ascending)') })
  assert.match(result.stderr, /error\[SEM0082\]/)
  assert.doesNotMatch(result.stderr, /A raw storage operation outside lexical unsafe authority/)
  assert.match(result.stderr, /qsort/)
})

test('a callback parameter without the callbacks property gets a coded error with the fix', { todo: 'finding 162' }, () => {
  const result = silk(h, ['check'], { cwd: variant(') -> () with Intrinsic.foreign(callbacks: ("compare",))', ') -> ()') })
  assert.doesNotMatch(result.stderr, /unsupported\[ForeignCallback\]/)
  assert.match(result.stderr, /callbacks: \("compare",\)/)
})

test('an ordinary fn passed for a C function pointer says to export it', { todo: 'finding 162' }, () => {
  const result = silk(h, ['check'], { cwd: variant('  unsafe qsort(first, 6, 4, ascending)', '  unsafe qsort(first, 6, 4, order)') })
  assert.match(result.stderr, /error\[SEM0012\]/)
  assert.match(result.stderr, /export "C"/)
})
