// Round 52: format templates (std/format: Format.format, Display, Debug, StderrWriter.print):
// alignment, fill, sign, zero padding, radix, floats, Unicode width, escapes, width and precision
// from fields, custom Display and Debug, and the compile errors for bad templates.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { here, initPackage, join, read, sharedHome, show, silk, write } from './lib.mjs'

const h = sharedHome()
let serial = 0

const expected = `1 [   42] [42   ] [ 42  ]
2 +7 -7 -0007 +0007
3 0xff 0xFF 0o10 0b101 ffffffff
4 0.30000000000000004 1 -0 3.142 2 4
5 1.2345e3 1.2E-4
6 [   héé] [--ab---]
7 {} {1}
8 [    3.14]
9 [  true] [x  ]
10 (3, -4)
11 Missing { id: 9, name: "a\\"b\\n" }
12 b a b
13 -9223372036854775808 18446744073709551615
14 Missing {
    id: 1,
    name: "x",
}
15 he|   hél|007
16 (1, 2) [1, 2] { x: 1 }
`

test('the format program in programs/ prints every template as documented', () => {
  const dir = initPackage(h, `format-${++serial}`)
  write(join(dir, 'src/main.silk'), read(join(here, 'programs/format.silk')))
  const result = silk(h, ['run', '--quiet'], { cwd: dir })
  assert.equal(result.status, 0, show(result))
  assert.equal(result.stdout, expected, show(result))
})

function check(line) {
  const dir = initPackage(h, `format-${++serial}`)
  write(join(dir, 'src/main.silk'), `import silk.os_writer { StderrWriter }\n\npub fn main() -> i32 {\n  ${line}\n  return 0\n}\n`)
  const result = silk(h, ['check'], { cwd: dir })
  assert.notEqual(result.status, 0, show(result))
  return result
}

for (const [name, line, message] of [
  ['a misspelled field lists the fields', 'StderrWriter.print("{nmae}\\n", &.{ name: "Ada" })', /SEM0177\] template field \{nmae\} not found; available visible fields: name/],
  ['mixing {} and {name} is refused', 'StderrWriter.print("{} {name}\\n", &.{ name: "Ada" })', /SEM0177\] template mixes positional and named arguments at \{name\}/],
  ['an unused tuple field is reported', 'StderrWriter.print("{}\\n", &(1, 2))', /SEM0177\] positional field 1 is not used by the template/],
  ['an unclosed placeholder is reported', 'StderrWriter.print("{name\\n", &.{ name: "Ada" })', /SEM0177\] template placeholder is not closed: \{name/],
  ['a positional field past the end counts the arguments', 'StderrWriter.print("{2}\\n", &(1, 2))', /SEM0177\] template placeholder \{2\} refers to positional field 2; the arguments have 2/],
  ['an unknown option shows the option grammar', 'StderrWriter.print("{:q}\\n", &(3,))', /SEM0177\] template placeholder \{:q\} has options that are not/],
]) {
  test(name, () => {
    const result = check(line)
    assert.match(result.stderr, message, show(result))
  })
}

// Finding 165: template messages that could say what to write.
test('a lone } says to write }}', { todo: 'finding 165' }, () => {
  const result = check('StderrWriter.print("} {name}\\n", &.{ name: "Ada" })')
  assert.doesNotMatch(result.stderr, /not closed/, show(result))
  assert.match(result.stderr, /\}\}/, show(result))
})

test('a width field that is not usize names the field', { todo: 'finding 165' }, () => {
  const result = check('StderrWriter.print("{name:>w$}\\n", &.{ name: "Ada", w: 5 })')
  assert.match(result.stderr, /\bw\b[^\n]*usize|usize[^\n]*\bw\b/, show(result))
})

test('a radix type on text says it needs an integer', { todo: 'finding 165' }, () => {
  const result = check('StderrWriter.print("{:x}\\n", &("Ada",))')
  assert.doesNotMatch(result.stderr, /RadixDisplay/, show(result))
  assert.match(result.stderr, /integer/, show(result))
})

test('template errors do not point into the stdlib', { todo: 'finding 165' }, () => {
  const result = check('StderrWriter.print("{nmae}\\n", &.{ name: "Ada" })')
  assert.doesNotMatch(result.stderr, /note: \S*stdlib\/silk\/format\.silk/, show(result))
})

test('passing the arguments without & says to borrow them', { todo: 'finding 165' }, () => {
  const result = check('StderrWriter.print("{}\\n", 5)')
  assert.match(result.stderr, /&/, show(result))
  assert.doesNotMatch(result.stderr, /A call argument whose type mismatches its parameter\n/, show(result))
})
