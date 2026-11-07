---
bump: minor
---

Static evaluation can borrow static data: `&value` and `&[a, b]` in a static body or constant are `&'static T` and `&'static [T]` views, so constants can hold trees like `subcommands: &'static [&'static Command]`; indexing, `.length` and field reads work through them.
