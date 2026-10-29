import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { rewrite, tables } from './UnicodeTables.mjs'

const unicodeData = [
  '00C0;LATIN CAPITAL LETTER A WITH GRAVE;Lu;0;L;0041 0300;;;;N;;;;00E0;',
  '0300;COMBINING GRAVE ACCENT;Mn;230;NSM;;;;;N;;;;;',
  '0301;COMBINING ACUTE ACCENT;Mn;230;NSM;;;;;N;;;;;',
  '0316;COMBINING GRAVE ACCENT BELOW;Mn;220;NSM;;;;;N;;;;;',
  '0340;COMBINING GRAVE TONE MARK;Mn;230;NSM;0300;;;;N;;;;;',
  '0344;COMBINING GREEK DIALYTIKA TONOS;Mn;230;NSM;0308 0301;;;;N;;;;;',
  'AC00;<Hangul Syllable, First>;Lo;0;L;;;;;N;;;;;',
  'D7A3;<Hangul Syllable, Last>;Lo;0;L;;;;;N;;;;;',
  '1E6E3;TAI YO SIGN UE;Mn;230;NSM;;;;;N;;;;;',
  '',
].join('\n')
const normalizationProps =
  '0340..0341    ; Full_Composition_Exclusion # Mn   [2]\n0344          ; Full_Composition_Exclusion # Mn\n'

it('packs classes into runs and keeps excluded pairs out of composition', () => {
  const generated = tables({ unicodeData, normalizationProps })
  assert.deepStrictEqual(
    generated.combiningClass.data,
    [
      0, 3, 0, 1, 230, 0, 3, 0x16, 0, 220, 0, 3, 0x40, 0, 230, 0, 3, 0x44, 0, 230, 1, 0xe6, 0xe3, 0,
      230,
    ],
  )
  assert.strictEqual(generated.singletons.count, 1)
  assert.deepStrictEqual(generated.pairs.data.slice(9), [0, 3, 0x44, 0, 3, 0x08, 0, 3, 0x01])
  assert.deepStrictEqual(generated.composition.data, [0, 0])
})

it('rewrites every table and bound in the stdlib module', () => {
  const source = readFileSync('stdlib/silk/text/unicode_tables.silk', 'utf8')
  const generated = tables({ unicodeData, normalizationProps })
  const result = rewrite(source, generated)
  assert.deepStrictEqual(result.issues, [])
  assert.include(result.source, 'let mut high = usize.add(0, 5)\n')
  assert.include(result.source, 'if found == 2 {')
  assert.include(result.source, '  return 2\n}')
  assert.include(result.source, 'let index = b"\\x00\\x00"')
})
