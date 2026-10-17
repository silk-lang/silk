# Modules, names, and visibility

Each Silk source file defines one module. A module's identity comes from its logical path relative
to the compilation source root, and imports create explicit names for declarations in other
modules. Imports are compile-time only: they do not run code or create values.

This page defines module identity, source lookup, import bindings, name collisions, and
cross-module visibility, and how packages depend on each other. Declaration-specific contracts
remain on their corresponding reference pages. Registries, remote acquisition, and version solving
are outside the language.

## Terminology

- A **source root** is the logical directory from which project module identities are derived.
- A **module identity** is a case-sensitive, extensionless path such as `model/User`.
- An **import path** is the dotted source spelling of a module identity, such as `model.User`.
- A **namespace binding** is a local name that qualifies members of one imported module.
- A **selected binding** is one imported declaration available directly under a local name.
- An **alias** is an explicit local name replacing a namespace or selected binding's default name.
- A **qualified name** begins with a namespace binding or a nominal type binding, as in
  `User.make`.
- An **associated item** is a variant, enum member, contract operation, or inherent member reached
  through a nominal type's qualifier. The type's module basename plays no role.
- A **module scope** is the set of top-level declaration and import names visible throughout one
  module.
- A **module closure** is the root module and every module reachable through its transitive imports.
- A **package** is one `silk.toml` manifest and the source root it selects. Its identity is
  `name@version` from the manifest.
- A **dependency name** is the key a manifest's `[dependencies]` table gives another package. It is
  the first segment of every import path that names that package's modules.

## Module identity and loading

### MODULE-001 — One source file defines one path-identified module

**Status:** Confirmed

Each `.silk` source file is one module. Its canonical identity is its case-sensitive,
extensionless path relative to the compilation source root, written with `/` between path
segments.

```text
<source root>/model/User.silk  ->  model/User
<source root>/app/Main.silk    ->  app/Main
```

Source code names the same identities with dotted import paths:

```silk
import model.User
```

Every segment is exact. `model.User` identifies `model/User.silk`; it does not find
`model/user.silk`, `model/User/index.silk`, or another extension.

**Boundary:** The identity is logical rather than an absolute host path. Absolute paths, source
extensions, empty segments, `.`, and `..` are not valid module identities. A source supplied from
memory still has one explicit logical identity even when it has no filesystem path.

**Diagnostics:** An import whose exact module does not exist reports `MOD0001` at the complete
import path. A compilation request whose root identity itself is noncanonical is a client
typed client error rather than a Silk source diagnostic. Reserved `silk/` identities always
resolve from toolchain sources, including when named as the root; project files and editor overlays
cannot replace them.

**Evidence:** [module closure](../../../../openspec/specs/bootstrap-module-closure/spec.md),
[source resolution](../../../../openspec/specs/bootstrap-source-resolution/spec.md),
[module closure tests](../../../../packages/compiler/test/ModuleClosure.test.ts).

### MODULE-002 — Source text does not declare or override module identity

**Status:** Confirmed

A Silk file contains declarations and imports but no module declaration. The source resolver assigns
its identity before parsing the file.

```silk
// model/User.silk is already module model/User.
pub struct User { id: i32 }
```

Moving or renaming the file changes the module identity and therefore the canonical identities of
its declarations. Imports must name the new path.

**Boundary:** Module documentation, a namespace alias, or a declaration named `User` does not change
the containing module's identity. Two identical source texts supplied as `model/User` and
`archive/User` define distinct modules and distinct declarations.

**Diagnostics:** Silk has no module-declaration syntax. A declaration-like spelling attempting to
introduce one receives the ordinary lexer or parser diagnostic for unsupported syntax. An import
that still names the old path reports `MOD0001`.

**Evidence:** [canonical module identity](../../../../openspec/specs/bootstrap-module-closure/spec.md),
[syntax files](../../../../openspec/specs/bootstrap-syntax-file/spec.md).

### MODULE-003 — Import paths resolve from the source root, not from the importing file

**Status:** Confirmed

Every project import is absolute within the compilation source root. The same import path identifies
the same module no matter which module contains it.

```text
<source root>/app/features/Profile.silk
<source root>/model/User.silk
```

```silk
// app/features/Profile.silk
import model.User
```

This resolves `<source root>/model/User.silk`. It does not begin lookup below
`app/features/`.

By default, the entry file's containing directory is the source root. A project or compiler client
may select an explicit source root; a nested entry then keeps its path below that root as its module
identity.

**Boundary:** Silk has no relative import spelling. An import cannot use `.` or `..` to walk from
the importing module, and resolution does not probe parent directories or alternate file layouts.

**Diagnostics:** A syntactically valid path with no exact source reports `MOD0001`. A file that
exists but cannot be read produces an operational source-resolution failure rather than pretending
that the module is absent.

**Evidence:** [filesystem source lookup](../../../../openspec/specs/bootstrap-source-resolution/spec.md),
[source resolver tests](../../../../packages/compiler/test/SourceResolver.test.ts).

### MODULE-004 — Compilation loads only the transitively reachable module closure

**Status:** Confirmed

Compilation requests name one canonical root module string, such as `app/Main`. The front end
resolves its bytes and source origin through the same source resolver used for imports, then follows
its imports transitively. Each reachable module
identity is resolved and parsed at most once, even when several modules import it.

```text
app/Main -> feature/Left  -> shared/Value
         -> feature/Right -> shared/Value
```

A missing or unreadable requested root returns a typed error before a successful analysis snapshot
exists. Failed imports can still leave the successfully loaded modules available for analysis.
In-memory callers register the root bytes with their resolver, just as they register dependencies.

`shared/Value` belongs to the closure once. A source available to the resolver but unreachable from
`app/Main` is not part of that compilation merely because it exists below the source root.

Every loaded root-package module has its active nongeneric, provider-free declarations checked,
even when no executable use reaches them. A dependency module, including a toolchain standard-
library module, is checked where a use reaches its declarations. Generic and provider-dependent
bodies retain existing symbolic contract typing where possible. Complete MIR and ownership
verdicts require a concrete use; full standalone checking of unspecialized bodies is deferred.
Bodies with unsupplied static inputs or generic-dependent static expansion defer whole-body typing.
The standard library can itself be compiled as the root package to check its otherwise unreached
closed declarations under the same rule.

**Boundary:** Loading still parses the whole source and makes its declarations available for static
analysis. Declaration checking does not make every function executable or include it in the emitted
program. Runtime reachability is a separate property beginning at the selected entry point.

**Diagnostics:** Each absent reachable target reports its import diagnostic. A damaged import path
retains its parser diagnostic without also requesting a fabricated module or emitting `MOD0001`.
An unused invalid closed root-package declaration rejects the build with its ordinary source
diagnostic; an unreached dependency body has no independent body verdict. One operational resolution
failure does not erase successfully loaded modules, although the compilation cannot commit its
requested artifact.

**Evidence:** [reachable module closure](../../../../openspec/specs/bootstrap-module-closure/spec.md),
[module closure tests](../../../../packages/compiler/test/ModuleClosure.test.ts),
[executable closure](../../../../openspec/specs/bootstrap-intrinsic-target-availability/spec.md),
[native declaration checking](../../../../compiler/docs/loaded-declaration-checking.md).

### MODULE-005 — Imports have no runtime behavior

**Status:** Confirmed

An import contributes names to its containing module's static scope. It does not execute the
imported source, initialize runtime module state, construct an Effect, allocate storage, or change
ownership.

```silk
import logging.Logger

pub fn main() -> i32 {
  return 42
}
```

The import alone performs no logging and creates no `Logger` value or service requirement.

**Boundary:** Calling an imported function, constructing an imported value, or mentioning an
imported service in an Effect contract has the ordinary behavior of that declaration. The import
itself contributes none of that behavior.

An import also does not implicitly re-export names or activate unlisted methods, operators,
overloads, or runtime providers. Interface-conformance availability is defined with interface and
specialization rules rather than by runtime import side effects.

**Diagnostics:** A valid but unused import is not a compiler error. Tooling may report a removable
unused-import warning. Invalid bindings retain their import or name-resolution diagnostics even
when no runtime expression uses them.

**Evidence:** [behavior-neutral imports](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[module semantic surface](../../../../openspec/specs/bootstrap-module-semantic-surface/spec.md).

### MODULE-006 — Import cycles are valid and do not choose lookup order

**Status:** Confirmed

Distinct modules may import each other. The cycle itself is not an error because all reachable
top-level declaration headers are known before function bodies resolve.

```silk
// a/A.silk
import b.B

pub fn main() -> i32 {
  return B.answer()
}
```

```silk
// b/B.silk
import a.A

pub fn answer() -> i32 {
  return 42
}
```

The modules form an import cycle, and `A.main` still resolves `B.answer` canonically.

**Boundary:** Valid import cycles do not make invalid type or value cycles safe. A recursively
embedded nominal value with no indirection remains invalid under its value-type rules. Calling
mutually recursive functions can also fail to terminate at runtime even though their names resolve.

**Diagnostics:** An import cycle alone emits no source diagnostic. Each declaration inside it still
receives its ordinary signature, visibility, type, ownership, and control-flow diagnostics.

**Evidence:** [module cycle facts](../../../../openspec/specs/bootstrap-module-closure/spec.md),
[cycle-safe lookup](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[name-resolution cycle tests](../../../../packages/compiler/test/NameResolution.test.ts).

## Import bindings

### IMPORT-001 — A namespace import binds the target's final path segment

**Status:** Confirmed

A namespace import without an alias creates one local namespace binding. Its default name is the
last segment of the imported module path.

```silk
import model.User

pub fn main() -> i32 {
  let user = User.make(42)
  return user.id
}
```

`model.User` identifies module `model/User` and binds local namespace `User`. `User.make` then
looks up public member `make` in that module.

**Boundary:** The namespace is not a runtime value and does not import any member as an unqualified
name. `make(42)` is unresolved unless `make` is local or separately selected into scope.

**Diagnostics:** An unknown target reports `MOD0001` at the import path. A valid namespace with no
public member named by a qualified lookup reports the unknown-member diagnostic for that member.
A private member reports `SEM0015` rather than appearing unknown.

**Evidence:** [explicit import bindings](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[namespace lookup tests](../../../../packages/compiler/test/NameResolution.test.ts).

### IMPORT-002 — A namespace alias replaces the default local name

**Status:** Confirmed

`as` assigns an explicit local name to the imported module namespace.

```silk
import compiler.Syntax as Tree

pub fn main() -> i32 {
  return Tree.parse()
}
```

The module identity remains `compiler/Syntax`; only this importing module's local binding changes
from `Syntax` to `Tree`.

**Boundary:** The default name is not retained alongside the alias. `Syntax.parse()` is unresolved
unless another visible binding independently names `Syntax`. An alias does not rename the imported
module or any declaration it owns.

A redundant alias such as `import compiler.Syntax as Syntax` is valid under IMPORT-005. Tooling may
offer to remove the unchanged alias.

**Diagnostics:** A missing alias name receives the parser's missing-token diagnostic without a
fabricated binding. Binding collisions use the collision rule rather than silently replacing an
existing name. An unchanged alias is compiler-valid; the LSP may report `LSP0002` and offer to
remove only the redundant alias clause.

**Evidence:** [import aliases](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[alias tests](../../../../packages/compiler/test/NameResolution.test.ts).

### IMPORT-003 — A selective import binds only its listed public members

**Status:** Confirmed

A selective import creates direct bindings for the declarations listed between braces. It does not
also create the module's default namespace binding.

```silk
import compiler.Syntax { Node, node, parse as read }

pub fn main() -> i32 {
  let value = node(42)
  return read(move value)
}
```

This binds public type `Node` as `Node`, constructor function `node` as `node`, and public function
`parse` as `read`. It does not bind namespace `Syntax`.

**Boundary:** Selection is explicit and non-recursive. Other public declarations in
`compiler/Syntax` do not become visible, and a selected declaration does not bring names used by
its implementation into the importing module.

Selecting a private declaration is distinct from selecting an unknown declaration: the former has
a known but inaccessible candidate; the latter has no candidate with that name.

**Diagnostics:** An unknown selected member reports `SEM0014` at that member. A private selected
member reports `SEM0015`. A local spelling claimed by another valid binding reports `SEM0016`
without choosing a winner.

**Evidence:** [selected import bindings](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[selected import tests](../../../../packages/compiler/test/NameResolution.test.ts).

### IMPORT-004 — A hybrid import may bind one namespace and selected members together

**Status:** Confirmed

One import may combine a namespace binding with selected-member bindings from the same target.

```silk
import compiler.Syntax as Tree { Node, node, parse }

pub fn main() -> i32 {
  return parse(node(20)) + Tree.width(Tree.node(22))
}
```

This binds namespace `Tree` and direct members `Node`, `node`, and `parse`. All bindings still
identify declarations owned by canonical module `compiler/Syntax`.

**Boundary:** The namespace alias affects only the namespace binding. It does not prefix or rename
the selected members. Each selected member may use its own explicit alias when a different local
name is needed.

The hybrid form is a compact way to request both namespace and selected bindings. IMPORT-006 also
permits separate declarations naming the same target when that organization is clearer.

**Diagnostics:** Each binding is checked independently for unknown members, inaccessibility, and
local collisions. Repeating the same canonical target is not itself a diagnostic.

**Evidence:** [hybrid import bindings](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[hybrid syntax provenance](../../../../packages/compiler/test/ModuleClosure.test.ts).

## Names and collisions

### NAME-001 — Top-level declarations are visible throughout their defining module

**Status:** Confirmed

A top-level declaration may be named anywhere in its defining module, including from a declaration
written earlier in the file. Source order does not control name availability.

```silk
pub fn main() -> i32 {
  return answer()
}

fn answer() -> i32 {
  return 42
}
```

`main` resolves the later `answer` declaration. Every top-level declaration header is collected
before function bodies resolve.

**Boundary:** This rule applies to top-level declarations, not local values. A local `let` binding,
parameter, or pattern binding exists only in its lexical scope and cannot be used before its
declaration. Runtime initialization order is not inferred from top-level source order because
imports and declarations do not execute module initialization.

**Diagnostics:** A top-level reference with no matching local or imported declaration receives the
ordinary unknown-name diagnostic for its position. It is not reported merely because the matching
declaration occurs later in the file.

**Evidence:** [declaration indexing](../../../../openspec/specs/bootstrap-declaration-index/spec.md),
[declaration index tests](../../../../packages/compiler/test/DeclarationIndex.test.ts).

### NAME-002 — One flat module namespace contains top-level declarations and imports

**Status:** Confirmed

Functions, nominal types, constants, services, interfaces, module namespace bindings, and selected
imports claim names in one flat module scope. Two different bindings cannot use the same local
spelling merely because they have different declaration kinds.

```silk,ignore
struct Token {}
fn Token() -> i32 { return 42 }
```

The second `Token` is invalid. The language does not choose between a type meaning and a function
meaning based on the expression's expected kind.

**Boundary:** A namespace and one of its members may legitimately have the same spelling because
qualification keeps them at different lookup positions. With `import model.User`, `User.User` may
name public declaration `User` inside module namespace `User`. The two `User` components are not
competing bindings in one scope.

Generic parameters, function parameters, local bindings, fields, and pattern bindings have their
own lexical or declaration-local scopes. Their collision rules are defined with those constructs.

**Diagnostics:** A repeated top-level declaration reports `SEM0003` at the later declaration and
points to the first. Distinct import or declaration bindings claiming one module-scope spelling
report `SEM0016` without selecting a winner.

**Evidence:** [flat module namespace](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[canonical declaration index](../../../../openspec/specs/bootstrap-declaration-index/spec.md).

### NAME-003 — A binding collision has no source-order winner

**Status:** Confirmed

When different valid declarations or imports claim the same local spelling, the name is unavailable
until the source gives the bindings distinct names. Import order, declaration order, and declaration
kind never select a winner.

```silk,ignore
import text.Parser { parse }
import binary.Parser { parse }

pub fn main() -> i32 {
  return parse()
}
```

Both imports claim `parse`, so the call resolves to neither function.

The same rule applies when an imported name collides with a declaration in the importing module:

```silk,ignore
import text.Parser { parse }

fn parse() -> i32 { return 42 }
```

**Boundary:** PRELUDE-001 defines no lower-priority standard-library namespace tier. Language
bindings retain their own reserved or collision rules; they do not let the module's explicit
bindings shadow one another. Distinct lexical scopes may reuse a spelling only where the
corresponding local binding rules allow it.

**Diagnostics:** Each colliding module-scope binding reports `SEM0016` with the complete candidate
set available to diagnostics and tooling. A use through that spelling remains unavailable instead
of producing a second misleading lookup result.

**Evidence:** [binding conflict diagnostics](../../../../openspec/specs/bootstrap-name-resolution/spec.md).

### NAME-004 — Explicit aliases resolve imported-name collisions

**Status:** Confirmed

Give colliding namespaces or selected members distinct local aliases.

```silk
import text.Parser
import binary.Parser as BinaryParser

pub fn main() -> i32 {
  return Parser.parse() + BinaryParser.parse()
}
```

Both canonical modules retain their original identities. Only their local names differ.

Selected members may be aliased independently:

```silk
import text.Parser { parse as parseText }
import binary.Parser { parse as parseBinary }
```

**Boundary:** Aliasing changes no declaration identity, type identity, visibility, ownership, or
runtime behavior. It also does not create an overload set: two functions still need distinct local
names when both would otherwise claim the same spelling.

**Diagnostics:** An alias that still collides with another binding reports `SEM0016`. A missing alias
name retains the parser diagnostic. An alias identical to the default spelling is the harmless
redundancy defined by IMPORT-005.

**Evidence:** [explicit import aliases](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[namespace alias tests](../../../../packages/compiler/test/NameResolution.test.ts).

### NAME-005 — A nominal qualifier exposes only its associated items

**Status:** Confirmed

A qualifier that resolves to a struct, union, enum, service, or interface exposes exactly that
declaration's associated items: union variants, enum members, contract operations, and the members
declared in the owner's inherent `impl` blocks. The module's file basename has no semantic role; a
declaration named after its file is an ordinary declaration.

```silk
// model/user_profile.silk
pub struct UserProfile { id: i32 }

impl UserProfile {
  pub fn make(id: i32) -> UserProfile {
    return UserProfile { id: id }
  }

  pub fn identifier(self: &Self) -> i32 {
    return self.id
  }
}

pub fn answer() -> i32 {
  return 42
}
```

```silk
// app/main.silk
import model.user_profile { UserProfile, answer }

pub fn main() -> i32 {
  let profile = UserProfile.make(answer())
  return UserProfile.identifier(&profile)
}
```

`UserProfile.make` and `UserProfile.identifier` resolve the inherent members of `UserProfile`.
`answer` is a root declaration of `model/user_profile` and is selected directly, because
`UserProfile.answer` names no associated item. A selected-import alias changes only the qualifier's
local spelling; the associated items follow the canonical declaration.

A namespace binding exposes only the module's root declarations:

```silk,ignore
import model.user_profile

let profile = user_profile.make(42)
```

`make` is a member of `UserProfile`, not a root declaration, so the namespace form reports an
unknown module member. Write `UserProfile.make(42)` through the selected type. The same boundary
applies to a root type reached through a nominal qualifier: `Format.ParseError` resolves nothing
when `ParseError` is a root struct of `silk/format`; select it directly with
`import silk.format { Format, ParseError }`.

An inherent member is never selected on its own. `import silk.option { map }` reports `SEM0197`
because `Option.map` is a member of `Option`; import the owner and qualify the member.

**Boundary:** An inherent member keeps the visibility of its declaration: a member declared without
`pub` is reachable as `Owner.member` only inside its module. A nominal qualifier never reaches an
imported binding, a private root declaration, or a public root declaration of its module. Scalar
enums keep their existing rule: their qualifier exposes declared members, the generated `value`
operation, and declared inherent members. Service and interface qualifiers expose their contract
operations and inherent members and nothing else; no lookup continues into the declaring module.

**Diagnostics:** An unknown member under a nominal qualifier reports `SEM0010`. An unknown member
under a namespace binding reports `SEM0014`. A private inherent member used outside its module
reports `SEM0015`. A selective import that names an inherent member reports `SEM0197`. A type
reached through a namespace binding where a value is required, including as the qualifier of its
own members (`order.Ordering.Less`), reports `SEM0222`; select the type and write
`Ordering.Less`.

**Evidence:** [basename has no semantic role](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[inherent member index](../../../../openspec/specs/bootstrap-declaration-index/spec.md),
[qualified lookup](../../../../packages/compiler/src/NameResolution.ts),
[standard-library namespace tests](../../../../packages/compiler/test/StdlibNamespaceAcceptance.test.ts).

## Visibility

### VIS-001 — Declarations are private by default and `pub` exposes them

**Status:** Confirmed

A top-level declaration without `pub` is private to its defining module. `pub` makes the declaration
eligible for access from another module through an explicit namespace or selected binding.

```silk
pub fn answer() -> i32 {
  return hidden()
}

fn hidden() -> i32 {
  return 42
}
```

Both functions are available inside their defining module. Another module may import or qualify
`answer` but not `hidden`.

The same default applies to nominal types, scalar enums, constants, services, interfaces, and other
top-level declarations that support cross-module access. Struct fields have their own `pub` marker
under the same private-by-default principle. A scalar enum's `pub` marker exposes its type and
complete member set; individual enum members have no separate visibility marker.

**Boundary:** `pub` grants name accessibility; it does not import the declaration anywhere,
re-export it from an importing module, execute it, or weaken its type, Effect, ownership, or target
contract.

**Diagnostics:** No diagnostic applies merely because a declaration is private or unused. An
external attempt to select or qualify it reports `SEM0015` at that use.

**Evidence:** [visibility lookup](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[struct visibility](values-and-types.md#struct-001--a-struct-declaration-creates-one-nominal-type),
[name-resolution tests](../../../../packages/compiler/test/NameResolution.test.ts).

### VIS-002 — Private declarations remain fully visible inside their defining module

**Status:** Confirmed

Privacy is a module boundary, not a declaration-order or same-file restriction. Any declaration
body in the defining module may name a unique private declaration.

```silk
fn normalize(value: i32) -> i32 {
  return value
}

pub fn parse(value: i32) -> i32 {
  return normalize(value)
}
```

`parse` may call `normalize` even though callers from another module cannot.

**Boundary:** A nested module is not created by directory structure within one source file. Every
source file has its own module boundary, so a neighboring file in the same directory does not gain
private access.

**Diagnostics:** A valid same-module private reference receives no visibility diagnostic. A private
declaration of the wrong kind still receives the ordinary kind or type diagnostic for its use.

**Evidence:** [defining-module visibility](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[declaration index](../../../../openspec/specs/bootstrap-declaration-index/spec.md).

### VIS-003 — Unknown and private imported members are different errors

**Status:** Confirmed

Lookup preserves whether an imported member is absent or exists but is private.

```silk,ignore
import model.User

User.missing() // no declaration named missing
User.secret()  // declaration exists, but is private
```

The first lookup is unknown. The second retains the private declaration as an inaccessible candidate
without making it callable.

This distinction applies equally to namespace qualification and selective imports, and to values,
types, constants, services, and interfaces.

**Boundary:** Privacy does not deliberately hide the fact that a declaration exists from compiler
diagnostics or navigation metadata. It prevents semantic access. User-facing diagnostics should
identify the inaccessible declaration without exposing private implementation details such as
hidden field sets.

**Diagnostics:** An unknown selected or qualified member reports `SEM0014`. A known private member
reports `SEM0015`. The compiler does not fall back to another module or prelude declaration after
either failed lookup.

**Evidence:** [visibility outcomes](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[private import tests](../../../../packages/compiler/test/NameResolution.test.ts).

### VIS-004 — A public contract cannot expose a private nominal type

**Status:** Confirmed

Every nominal type appearing in a public declaration's externally visible contract must itself be
public. This includes function parameters and results, public struct fields, and other published
type positions.

```silk,ignore
struct Hidden {}

pub fn reveal(value: Hidden) -> Hidden {
  return move value
}
```

`reveal` is invalid because an importing module could name the function but could not name its
parameter or result type.

A public type may use private representation types behind private fields:

```silk
struct Storage { value: i32 }

pub struct Counter {
  storage: Storage
}
```

The private field does not enter `Counter`'s externally accessible construction or projection
contract.

**Boundary:** A private declaration may freely mention other private declarations in its own
contract. A public function body may also use private types internally as long as they do not escape
through its published signature.

**Diagnostics:** Each private nominal type exposed by a public contract reports `SEM0019` at the
type use and retains the referenced declaration identity. The compiler does not pretend the type is
unknown or silently make it public.

**Evidence:** [nominal visibility](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[struct visibility specification](../../../../openspec/specs/bootstrap-struct-types/spec.md),
[private exposure tests](../../../../packages/compiler/test/DeclarationIndex.test.ts).

## Redundancy, prelude, and publication

### IMPORT-005 — Redundant aliases are semantically harmless

**Status:** Confirmed

An alias equal to the binding's default name does not change the program and should remain valid.

```silk,ignore
import model.User as User

pub fn main() -> i32 {
  return User.answer()
}
```

This has the same binding and runtime meaning as `import model.User`.

**Boundary:** An alias that claims another binding's spelling is not merely redundant; it is a real
collision under NAME-003. A missing alias name remains malformed syntax.

**Diagnostics:** The compiler does not reject an unchanged alias. Language tooling may report a
non-blocking `LSP0002` simplification warning and offer to remove `as User`.

**Evidence:** [current alias policy](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[redundant alias tests](../../../../packages/compiler/test/NameResolution.test.ts).

### IMPORT-006 — The same module may be imported more than once

**Status:** Confirmed

Import declarations are judged by the bindings they create, not by whether another declaration
names the same target module. Distinct declarations may request separate noncolliding views of one
module.

```silk,ignore
import model.User as UserApi
import model.User { User }

fn reset(user: User) -> User {
  return UserApi.withId(move user, 0)
}
```

Both imports identify canonical module `model/User`. The first binds namespace `UserApi`; the second
binds public type `User` directly.

**Boundary:** Repeated imports do not permit conflicting local names. Two declarations importing
different members as the same spelling still report `SEM0016`. Importing an identical binding twice
is an idempotent redundancy rather than a second declaration identity.

**Diagnostics:** Repeated targets alone do not produce a compiler error. Tooling may suggest
combining compatible imports into one hybrid declaration or removing an exact duplicate. The
LSP uses `LSP0001` for an exact duplicate and `LSP0003` when declarations can be consolidated.

**Evidence:** [current repeated-target restriction](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[duplicate import tests](../../../../packages/compiler/test/NameResolution.test.ts).

### IMPORT-007 — Reserved words may appear in import paths but cannot become implicit bindings

**Status:** Confirmed

When the parser expects an import-path segment, it accepts identifier and reserved-word tokens
without changing their lexical classification. A reserved final segment must use an explicit legal
namespace alias or a selected-member list so the import never creates a binding whose spelling is
otherwise reserved.

```silk
import silk.effect { Effect }
```

Reserved segments in any nonfinal position are ordinary parts of the canonical module identity.
Every module-closure, name-resolution, formatting, and tooling consumer observes the same ordered
path segments.

**Boundary:** Contextual acceptance is limited to import paths. A reserved word remains invalid as a
declaration name or explicit alias. `import silk.effect` is invalid because its implicit namespace
binding would be named `effect`; selected-member imports such as `import silk.effect { Effect }`
are valid because they state legal bindings explicitly. A legal explicit namespace alias remains
valid under IMPORT-002 when a caller specifically needs the module namespace.

**Diagnostics:** A reserved final segment without an alias or selected-member list reports
`PAR0004` at that segment and explains that the import needs an explicit binding form. The parser
retains the complete path for recovery, but name resolution does not synthesize a reserved binding.

**Evidence:** [import syntax requirements](../../../../openspec/changes/rename-effect-module/specs/bootstrap-syntax/spec.md),
[name-resolution requirements](../../../../openspec/changes/rename-effect-module/specs/bootstrap-name-resolution/spec.md),
[contextual path parser tests](../../../../packages/compiler/test/Parser.test.ts),
[canonical path consumer tests](../../../../packages/compiler/test/ModuleClosure.test.ts),
[explicit completion behavior](runtime-and-standard-library.md#tooling-001--tooling-presents-library-source-and-derived-availability-honestly).

### PRELUDE-001 — Only language bindings are implicit

**Status:** Confirmed

Foundational type spellings, language syntax, and the sealed `Intrinsic` namespace are available
without imports. Ordinary standard-library types and namespaces are not. A module imports every
standard-library API it names.

```silk
import silk.option { Option }

pub fn main() -> i32 {
  let value = Option<i32>.some(42)
  drop value
  return 42
}
```

The type spelling `i32` needs no import because it is part of the language. `Option.some` needs the
explicit `Option` binding because `Option` is an ordinary standard-library union and `some` is one
of its inherent members, reached through the type under NAME-005. The same rule applies to
`Effect`, `Vector`, `Result`, filesystem services, target providers, and the primitive namespaces:

```silk
import silk.effect { Effect }
import silk.i32
```

`Effect<A ! E ? R>` remains language type syntax. The selected binding `Effect` names the ordinary
standard-library struct `Effect`, and `Effect.provide` is an inherent member declared in that
struct's `impl Effect` block. `silk.i32` declares no owner type: its operations are root
declarations reached through the namespace binding `i32`.

The ownership properties are ordinary standard-library names too. `Copy` and `Drop` are aliases of
the sealed `Intrinsic.Copy` and `Intrinsic.Drop` published by `silk.ownership` (INTR-006), and a
module that spells them imports them:

```silk
import silk.ownership { Copy }

struct Point { x: i32 y: i32 }

impl Copy for Point {}

pub fn main() -> i32 { return 42 }
```

**Boundary:** The toolchain may resolve the reserved `silk/` source origin differently from project
files, but that packaging privilege does not inject its declarations into every module scope.
Tooling may add missing imports automatically; auto-import is a source edit, not invisible lookup.

A foundational type spelling does not create an ordinary nominal declaration in the module scope.
Therefore `import silk.i32` may bind namespace `i32` while type positions continue to use the
closed language spelling `i32`; selecting the `Effect` struct behaves similarly beside Effect type
syntax. This does not create general separate type and value namespaces for user
declarations.

**Diagnostics:** Naming an unimported standard-library namespace uses the ordinary unknown-name
diagnostic. Catalog-backed completion may add a visible, collision-aware import edit.

**Evidence:** [current prelude tier](../../../../openspec/specs/bootstrap-name-resolution/spec.md),
[standard-library namespace tests](../../../../packages/compiler/test/StdlibNamespaceAcceptance.test.ts),
[foundational type names](values-and-types.md#type-001--foundational-type-spellings-are-lowercase-and-distinct).

### EXPORT-001 — Selective publication is explicit

**Status:** Confirmed

An ordinary import creates private bindings in its importing module. Another module cannot access
those bindings merely by importing that module. Use `pub import` with an explicit member list to
publish selected public declarations, optionally under local aliases:

```silk
pub import model.User { User, make as makeUser }
```

The published names retain the original declarations' canonical identities, types and contracts.
Publication chains resolve those identities without wrapper functions. Private members cannot be
published, and conflicting selected bindings are diagnosed. Module static declaration groups may
publish mutually exclusive alternatives under the same name.

**Boundary:** `pub import model.User` without an explicit member list and wildcard publication are
invalid. An optional namespace alias in a selective import remains private. Ordinary imports do
not implicitly publish names or activate unlisted methods, operators, conformances or runtime work.

**Diagnostics:** A public import without a member list receives a parser diagnostic. Missing or
private selected members retain the normal unknown-member or inaccessible-member diagnostics.
Selected binding collisions retain their ordinary diagnostic and declaration origins.

**Evidence:** [module static selection](module-static-selection.md) and
[selection design](../../../../openspec/changes/add-module-static-selection/design.md).

## Packages

### PACKAGE-001 — A package is one manifest and its source root

**Status:** Confirmed

A `silk.toml` manifest defines one package. `[package].name` and `[package].version` form its
identity, `name@version`, and its modules are the `.silk` files below its source root under
MODULE-001. A package's own imports keep the source-root rule of MODULE-003.

```toml
[package]
name = "silk-json"
version = "0.2.0"
source-root = "src"
```

The source root is `[package].source-root` when the manifest names one, else the directory of
`[package].root`. A package that is only ever a dependency needs no `root`, but it must name a
`source-root`.

**Boundary:** The identity is logical. Two checkouts of the same package at different host paths
have the same identity, and a module's identity never contains a host path.

**Diagnostics:** A manifest without a name, a version, or a source root is an invalid-manifest error
from the build, not a Silk source diagnostic.

**Evidence:** [native package sources](../../../../compiler/src/driver/ModuleSources.silk),
[native manifest decoding](../../../../compiler/src/driver/Project.silk).

### PACKAGE-002 — A dependency name is the first segment of its import paths

**Status:** Confirmed

`[dependencies]` names the packages this package may import. Each key is the dependency name source
code uses; `path` names the directory holding that package's manifest, relative to this manifest.

```toml
[dependencies]
json = { path = "../silk-json" }
syntax = { path = "../tools/syntax", package = "silk-syntax" }
```

```silk
import json.Value { Value, parse }
import syntax.Parser as P
import model.User
```

`json.Value` names module `Value` below the source root of `silk-json`. `model.User` still names this
package's own `model/User.silk`, because `model` is not a dependency name. A dependency's modules
resolve their own imports against that package's source root and its own `[dependencies]`.

The module identity is the dependency's package identity and its path below that package's source
root; the dependency name plays no role. Two packages that depend on the same package share its
modules and declarations, whatever names they give it.

**Boundary:** A dependency name must be an identifier other than `silk` or `Intrinsic`. When
`package` is present it must equal the dependency's `[package].name`. Dependencies are not
transitive: a package imports only the packages its own manifest lists. Packages cannot depend on
each other in a cycle. Only `path` dependencies exist; a dependency on a registry or a repository is
outside the language for now.

**Diagnostics:** An invalid dependency name, a missing or unreadable dependency manifest, a
`package` name that does not match, and a package cycle are invalid-manifest errors that name the
dependency. A path below a dependency with no exact module reports `MOD0001` like any other import.

**Evidence:** [native package graph](../../../../compiler/src/semantic/PackageGraph.silk),
[package dependency loading](../../../../compiler/src/driver/Packages.silk),
[dependency resolution cases](../../../../compiler/src/semantic/SemanticConformanceCases.silk),
[dependency loading cases](../../../../compiler/src/semantic/SemanticLoweringCases.silk),
[native build contract](../../../../compiler/scripts/test-native-build.ts).

### PACKAGE-003 — A dependency name is reserved in its package's source root

**Status:** Confirmed

A dependency name cannot also be the first segment of one of the package's own modules. A source
root that holds `json.silk` or a `json/` directory cannot also list a dependency named `json`.

**Boundary:** The reservation is per package. A dependency may have its own `json/` modules even
when the package that imports it calls it `json`.

**Diagnostics:** The build reports an invalid-manifest error naming the dependency and the
conflicting source path. Neither side silently wins.

**Evidence:** [native build contract](../../../../compiler/scripts/test-native-build.ts).

### PACKAGE-004 — A build holds one version of each package

**Status:** Confirmed

Every package in a build has a distinct name. Two dependencies that reach the same package name
must reach the same version from the same directory, and then they are one package.

**Boundary:** Two different versions of one package, or one `name@version` read from two different
directories, cannot be combined. Because only path dependencies exist, there are no version ranges
and no lockfile.

**Diagnostics:** The build reports an invalid-manifest error naming the package and both sources.

**Evidence:** [native build contract](../../../../compiler/scripts/test-native-build.ts).

### PACKAGE-005 — The standard library is the implicit dependency `silk`

**Status:** Confirmed

Every package depends on the toolchain's standard library under the dependency name `silk`, without
listing it. The toolchain supplies it and versions it with the compiler (DIST-001), and every package
in a build shares the same standard-library modules.

This is an implicit dependency, not an implicit import. PRELUDE-001 still requires each module to
import the standard-library names it uses.

**Boundary:** A manifest cannot list a dependency named `silk`, and a project file cannot shadow a
standard-library module.

**Diagnostics:** Listing `silk` is an invalid-manifest error.

**Evidence:** [native package graph](../../../../compiler/src/semantic/PackageGraph.silk).

### PACKAGE-006 — `exports` choose the modules other packages may import

**Status:** Confirmed contract; not implemented yet.

`[package].exports` lists the module paths, in import spelling, that other packages may import.
Inside the package every module stays importable. A package without `exports` exposes no module to
other packages.

```toml
[package]
name = "silk-json"
version = "0.2.0"
source-root = "src"
exports = ["Value", "Parser"]
```

A library keeps its implementation in internal modules and publishes a small facade with selective
`pub import` (EXPORT-001). The standard library lists its catalog the same way, which replaces the
interim rule of STDLIB-006.

**Boundary:** `pub` still decides which declarations of an exported module are visible. An exported
module cannot publish a private declaration.

**Diagnostics:** Importing an unlisted module from another package reports a dedicated
internal-module error at the import path, distinct from `MOD0001` for a module that does not exist.
Its code is not assigned yet.

**Evidence:** Design approved on 2026-10-17; implementation pending.

### PACKAGE-007 — A workspace groups packages that build together

**Status:** Confirmed contract; not implemented yet.

A manifest with a `[workspace]` table lists member package directories. Members can depend on each
other by path, a build can start from any member, and members share one output directory.

```toml
[workspace]
members = ["compiler", "libs/*"]
```

**Boundary:** A workspace adds no import rule: members still import each other only through
`[dependencies]`.

**Diagnostics:** A member directory without a package manifest is an invalid-manifest error.

**Evidence:** Design approved on 2026-10-17; implementation pending.

## Implementation evidence

The compiler closes modules only through parsed imports, keeps catalog declarations out of source
scope, accepts harmless import redundancy, and preserves collision diagnostics for genuinely
different bindings. The LSP indexes the catalog independently, inserts explicit collision-aware
imports, and owns optional redundancy warnings and consolidation actions. Repository examples,
fixtures, tests, and generated documentation use the same explicit-import model.

Selective public imports are explicit re-exports; ordinary imports remain private.

## Unused import tooling

The language server reports `LSP0004` on each valid namespace or selected-member import binding that
has no semantic use in its module. Aliases are tracked as authored bindings, so using one alias does
not make another alias used. Explicitly published members and semantic references in module
conditions are uses. Qualified access uses the namespace binding rather than an independent
direct selector with the same declaration and spelling. Import declarations, comments, recovered
syntax, and matching text are not uses.

The **Remove unused import** quick fix removes only the selector and its owned delimiter, or removes
the whole declaration when it is the final binding. In a hybrid import, it can instead remove only
the namespace alias or selected-member clause. The fix is omitted when comment or trivia ownership
is ambiguous. Code actions reacquire the same binding and plan from the exact accepted document
version before returning an edit, so changed documents cannot receive stale offsets. This is a
tooling warning: it does not affect compiler diagnostics, lowering, code generation, or command
success. Imports themselves have no runtime behavior.
