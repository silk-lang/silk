---
bump: patch
---

Copying a parsed response head takes all of its field lines with one copy, through the new `OwnedHeaders.withRegion` and `OwnedHeaders.appendRecordUnchecked`, instead of appending each name and value. `sendAll` takes its results out in request order without reversing them twice.
