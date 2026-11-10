---
bump: minor
---

`StaticText.errorAt(text, start, end, message)` stops static evaluation with a compile error located at bytes `start..end` of `text`: inside the string literal it came from, escapes included, or in the declared name of the field whose `Reflect.fieldLabel` it is. `Regex.typed` uses it, so an invalid pattern points at the offending character, a group with no field at the group's name, and a field with no group or the wrong optionality at the field.
