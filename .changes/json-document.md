---
bump: minor
---

New `JsonDocument` (in `silk.json.value`) parses JSON into two flat buffers, like yyjson, instead of one allocation per value. It reads values by `JsonNode` (`root`, `kind`, `field`, `items`, `members`, `asString`, `asNumber`, `asBool`), writes with `write` and `writeWith`, and converts with `toValue` and `fromValue`. Parsing is 1.6 to 1.8 times faster than `Json.parse` on twitter.json, citm_catalog.json and canada.json.
