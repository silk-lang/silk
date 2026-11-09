---
bump: minor
---

Add `StaticText.link<Owner>(text, start, end, field)`, which ties characters of a literal to a struct field for the editor: hover shows the field and its doc, go to definition opens it, find references lists it and an inlay hint shows its type. `Regex.typed` links each group name to its field, and find references now works on struct fields.
