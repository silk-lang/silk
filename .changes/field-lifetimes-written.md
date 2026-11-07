---
bump: minor
---

A struct, union or tuple field, a declaration bound and an alias target write every lifetime they borrow for, and an implementation head writes the lifetimes of the type it implements, so a declaration has exactly the lifetimes its header shows. `impl Row<'static>` adds members for one lifetime only. A field whose type is a callable contract is now refused where it is declared, and a fixed SEM0210 message for recursive references now renders.

## Migration

Declare each lifetime a field borrows for and write it on the field, as in `struct Row<'a> { title: string<'a> }`, or write `'static` for program-long data. Write the lifetimes in implementation heads, as in `impl<'a> Row<'a>` or `impl<'a> Display for Row<'a>`, and replace `impl<'a: 'static> Row<'a>` with `impl Row<'static>`. Write a callable bound's environment, as in `struct Cb<F: fn<'static>(i32) -> i32> { f: F }`, and store a callable in a field through a type parameter bounded that way. Signatures and bodies are unchanged.
