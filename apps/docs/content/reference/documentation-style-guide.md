# Doc comment style guide

Doc comments are the primary documentation for public Silk APIs. A reader must be able to select
and use an API without leaving its source comment or generated reference page.

This guide defines the documentation style for Silk. The standard library and official Silk
examples must follow it. Published Silk packages should use the same style.

This guide defines writing rules. It does not change the meaning or validity of Silk programs.

## Standard structure

Every public API must have a doc comment with one short, standalone summary. Add the remaining
sections only when they teach useful information. Use this order:

1. `# When to use`
2. `# Details`
3. `# Gotchas`
4. `# Examples`
5. `# See also`, for module comments only

The template is a menu, not a checklist. Omit an empty, repetitive, or speculative section.

In declaration comments, use one blank comment line between the summary, each section heading, its
content, and each example heading. Declaration comments use this form:

````silk,ignore
/// Returns one value that has the documented result.
///
/// # When to use
///
/// Use this function when the reader must select this API.
///
/// # Details
///
/// Explain the mental model, guarantees, options, or observable behavior.
///
/// # Gotchas
///
/// Explain a concrete precondition, boundary, failure, or surprise.
///
/// # Examples
///
/// ## Use the result in one complete program
///
/// Explain a choice only when the code cannot show it.
///
/// ```silk
/// import silk.option { Option }
///
/// pub fn main() -> i32 {
///   let value = Option<i32>.some(2)
///   let result = move value
///     |> Option<i32>.unwrapOr(0)
///   if result != 2 {
///     let mismatch = 1 / 0
///   }
///   return 0
/// }
/// ```
````

The source syntax uses Markdown headings inside both `//!` and `///` comments. The documentation
tools rebase these headings in generated pages.

## When to document

Document every public module and public member. Small or familiar APIs have no exception.

Use `//!` for public module documentation. Use `///` for each public declaration and each member of
its public contract. This requirement includes:

- public types and their public fields or variants;
- public functions, methods, and constants;
- public service and interface operations;
- public constructors; and
- implementation members that users can name.

A module comment does not replace a member comment. A type comment does not replace a field or
operation comment. Put each `///` block directly before its documented item.

Write each public comment for a reader who can see only that comment and its example. Do not require
the reader to open the module comment, type comment, or another member comment.

A link can provide more information. A link cannot contain required information. Repeat each
precondition, failure mode, ownership rule, and safety rule that controls correct use.

Internal members can use shorter comments. Document the reason for a helper, an invariant, or a
non-obvious constraint. Do not add a teaching comment to a trivial private operation.

## Module header documentation

Every public module must start with a `//!` block. Put it before imports, ordinary comments, and
declarations.

The module header teaches the shared model. It must name the principal public type or capability
and its principal operations. It must help the reader select this module instead of a related
module.

Use one summary paragraph. Add useful sections in the standard order. Under `# Examples`, use one
`##` heading for each example title. Each example must satisfy the complete-program rules below.

Use one blank `//!` line before each module section. Put section content directly after its heading.

The `silk.box` header is the model:

```silk,ignore
//! One owned heap indirection for recursive data and values whose storage must have a stable size.
//!
//! # When to use
//! Use [`Box`] to break an inline layout cycle, such as a tree node that owns more tree nodes. Use
//! [`make`] to allocate, [`get`] or [`getMut`] to borrow the element, and [`into`] to recover it.
//!
//! # Details
//! A box owns one allocation and one value. [`get`] and [`getMut`] return a one-element slice.
//! Silk cannot return a bare borrowed value. Dropping the box also drops its element. [`into`]
//! transfers the element and releases the allocation one time.
//!
//! # Gotchas
//! Recursive destruction uses the call stack. For a deep chain, use [`into`] in an iterative loop
//! when stack depth is important.
```

The summary names the concept. `# When to use` gives the selection rule and principal entry points.
`# Details` gives the ownership model. `# Gotchas` gives the shared stack risk.

The module header does not replace member documentation. For example, the comment for `get` must
still state its return shape and borrow behavior.

## Links and related APIs

Use a link when navigation helps the reader understand, select, or use the API. Do not link a name
only because a link is possible.

Use a shortcut symbol link for a documented symbol in the same module:

- ``[`Box`]`` links the principal type.
- ``[`make`]`` links a constructor or operation.
- ``[`get`]``, ``[`getMut`]``, and ``[`into`]`` link related operations.

The link text must use the exact public symbol name. The documentation build must resolve every
symbol link. Do not publish a broken or ambiguous link.

Use code formatting without a link when:

- the text refers to the member that owns the current comment;
- the name is a value, expression, parameter, or language construct;
- the symbol-link resolver cannot reach the target; or
- repeated links make a paragraph difficult to read.

For example, use `self`, `None`, `|>`, and `silk.string.String` as code when no resolvable symbol
link is available.

Link a related API when it is:

- a safer or more general alternative;
- an inverse operation;
- a constructor for the documented type;
- a principal consumer of the result; or
- necessary to explain a choice between similar operations.

Link the first useful mention in a paragraph. Do not link each repetition. Do not use “here” or
“click here” as link text.

Use `[descriptive title](https://example.com)` for an external document. Link the stable primary
source. Do not use a raw URL as prose.

Use `# See also` only in a module header. Use it for useful relationships that do not fit an earlier
section. In member comments, put the relationship in the relevant section.

## Complete comments

A complete comment gives information that the declaration and types cannot give. Depending on the
API, this information includes:

- its purpose and result;
- the reason to select it instead of a related API;
- its mental model and important guarantees;
- observable defaults and option behavior;
- ownership, mutation, laziness, allocation, ordering, or concurrency behavior;
- failure conditions, boundary cases, and non-obvious preconditions; and
- a realistic example when prose and the declaration are not sufficient.

Completeness does not mean that prose repeats the signature. Do not list each parameter, restate an
obvious type, or describe an implementation detail with no observable effect.

Before approval, confirm that a reader can answer these questions:

1. What does this API do?
2. Is this the API that I must select?
3. What behavior does the API guarantee?
4. What can surprise me?
5. Can I adapt the example to my program?

A simple constant can need only a summary. A concurrency primitive can need the complete structure.

## Summary

The summary is required. Editors, completion lists, and generated indexes frequently show only the
summary. It must stand alone.

- Write exactly one short paragraph.
- State the public contract, not the implementation technique.
- Start a function with a present-tense action, such as “Returns”, “Creates”, or “Runs”.
- Describe a type or value with a precise noun phrase.
- Name an important distinction when its omission makes the API sound like a related API.
- Do not start with “This function”, “This method”, or the symbol name.
- Do not promise behavior that the API does not guarantee.

Good:

```silk,ignore
/// Returns the first element that satisfies `predicate`, or `None` if no element matches.
```

Weak:

```silk,ignore
/// Finds an element.
```

The weak summary does not identify the selected element or the absent result.

## When to use

`# When to use` helps the reader select an API. It must add selection guidance and not repeat the
summary.

Add it when:

- related APIs have similar names or overlapping capabilities;
- the API has an important trade-off;
- the API supports a specific composition pattern; or
- ownership, performance, failure, or lifecycle controls the selection.

Start with “Use when”, “Use to”, “Use for”, or “Use as”. Write from the reader's
goal.

Good:

```silk,ignore
/// # When to use
///
/// Use this function when you must inspect a sequence without consuming it.
```

Weak:

```silk,ignore
/// # When to use
///
/// Use this function when you want to call `peek`.
```

When two APIs form a choice, explain the niche of each API in its own comment. Do not put the full
module catalog in one member comment.

## Details

`# Details` teaches the mental model and the behavior that a caller can use. It answers “How does
this API behave?” and “What does the API guarantee?”

Useful subjects include:

- evaluation order, laziness, and callback execution;
- ownership, borrowing, copying, mutation, and allocation;
- ordering, deduplication, buffering, batching, and backpressure;
- cancellation, cleanup, concurrency, and thread-safety guarantees;
- the interaction of options or overloads;
- observable defaults;
- stable complexity guarantees that affect API selection; and
- the relationship between inputs, outputs, and errors.

Use a short paragraph for one idea. Use a list for parallel facts. Explain the public concept before
lower-level mechanics. Include an implementation technique only when callers can observe it.

Do not use `# Details` as a collection of unrelated facts. Put selection facts in `# When to use`.
Put hazards and surprises in `# Gotchas`.

## Gotchas

`# Gotchas` records concrete facts that can make reasonable code incorrect. It is not a required
warning label.

Add it for:

- a non-obvious precondition;
- a boundary case with a surprising result;
- partial consumption or mutation before failure;
- truncation, overflow, precision loss, or platform dependence;
- a resource lifetime or cleanup hazard;
- a cancellation or concurrency race;
- a trap or error that the type does not make clear; or
- behavior that readers can confuse with a related API.

State the trigger and observable result. State how to prevent the problem when that information is
useful.

Good:

```silk,ignore
/// # Gotchas
///
/// If `limit` is zero, the callback does not run and the result is empty.
```

Weak:

```silk,ignore
/// # Gotchas
///
/// Be careful with edge cases.
```

Do not invent a gotcha. Do not repeat an ordinary type error. Do not make an unstable implementation
accident part of the public contract.

## Examples

An example must teach a fact that prose and the declaration cannot show as clearly. Examples are
optional, including for public APIs.

Use only these two example forms:

1. A complete, self-contained Silk program that a reader can copy, build, and run. Always prefer
   this form.
2. A legal sequence of statements that can appear unchanged inside a function or block. Use this
   form only when the declarations and setup of a complete program would obscure the behavior.

Do not publish isolated declarations, call lists, or expression fragments as examples. Put exact
signatures in reference prose or a declaration block instead.

Every complete-program example must:

- have a short, result-oriented `##` title;
- contain one focused scenario;
- use only public APIs;
- contain all required imports, providers, declarations, and setup;
- be a complete Silk program that the compiler accepts;
- make its result observable with a return value, an assertion, or explicit expected output;
- show the distinctive behavior of the documented API;
- pass `silk check` in documentation validation;
- pass `silk format --check`; and
- run successfully when it has executable behavior.

Every statement-sequence example must:

- contain only statements that are legal in a Silk function or block;
- use names and types that the adjacent text defines;
- show one operation whose surrounding program would add irrelevant detail; and
- be verified inside a minimal complete program before publication.

Use short comments inside an example when they explain ownership transfer, control flow, failure,
or another fact that is not clear from syntax alone.

Do not use pseudocode, `...`, incomplete expressions, hidden imports, placeholder APIs, or bare API
call inventories. Do not assume that the reader can open other documentation.

Prefer titles such as “Use an absent fallback” or “Get the second vector element”.
Do not use “Example”, “Basic usage”, or “Syntax”.

Use prose before code only when it explains a decision that the code cannot show. Do not describe
each line after the example.

Order multiple examples from the most common case to the most specialized case. Give each example
a different title.

### Owner imports

When an operation is an inherent member of a standard-library type, import that owner type directly
in documentation examples and qualify the operation through it. A selected type exposes its
associated items, so calls remain qualified and contextual. This follows
[STYLE-003](style-guide.md#style-003--examples-import-the-owner-type-and-qualify-operations-through-it).

Preferred:

```silk
import silk.usize

import silk.vector { Vector }

pub fn main() -> i32 {
  let values = Vector<i32>.make()
  let count = Vector<i32>.length(&values)
  return count
    |> usize.toI32
}
```

Use a namespace import when the operation is a root declaration with no owner type, as in the
primitive modules. A namespace binding exposes only root declarations and never an inherent member.
Do not import root operations as unqualified names when that removes useful context; an inherent
member such as `make`, `append`, `get`, or `length` cannot be selected on its own.

`Vector.length` gives context that `length` does not give. This rule is mandatory in official
documentation examples.

### Pipe operator

Use `|>` when data flows through one or more operations. A pipe shows operation order and keeps the
actor name visible.

For example, write `move present |> Option<i32>.unwrapOr(0)` for an owned option. Use
`|> Effect.provideMut(...)` to supply an Effect requirement.

Do not use `|>` when the result is not valid Silk or when a direct call is clearer. A lexical borrow
may flow through a pipeline when the next callable expects that borrowed view. Prefer the form that
makes the operation order clearest.

## ASD-STE100 Simplified Technical English

Write doc-comment text in ASD-STE100 Simplified Technical English (STE). Use
[ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), dated
15 January 2025. The official standard is the authority. This summary does not replace it.

This requirement applies to summaries, section text, example titles, comments in examples, and link
descriptions. Silk identifiers and established programming terms are technical nouns or technical
verbs. Use each technical term with one meaning.

At minimum:

- Use an approved word for its approved meaning and part of speech.
- Use one term for one concept. Do not use synonyms for variation.
- Use active voice unless the actor is unknown or not important.
- Use present tense for descriptions.
- Put a condition before its result when the condition controls interpretation.
- Put one topic in each sentence.
- Use no more than 20 words in an instruction, warning, or caution.
- Use no more than 25 words in a descriptive sentence.
- Use no more than six sentences in one paragraph.
- Do not omit an article, noun, or verb to make a sentence shorter.
- Do not use contractions.
- Do not use an `-ing` word unless STE approves it or it is an established technical term.
- Do not use filler such as “simply”, “just”, “obviously”, or “basically”.

Use exact conditions and quantities.
Do not use “sometimes”, “usually”, or “may” for deterministic behavior.
Do not describe an API as “fast”, “safe”, or “lightweight” without a precise guarantee.

Format identifiers, values, and short expressions as code. Examples include `Option.none`,
`usize.ZERO`, and `Vector.get`.

## API families

Put the complete shared model on the central type, interface, service, or module. Each public member
must still work as an independent documentation entry point.

- Give each member a standalone summary.
- Repeat the shared facts that control correct use of that member.
- State each applicable precondition, failure mode, ownership rule, and safety rule.
- Link to related APIs only for more information or navigation.
- Do not require a link to understand the member contract.

Do not copy unrelated parts of the shared model. The goal is independent understanding, not
identical comments.

## Complete style examples

These examples use standard-library APIs. Documentation validation must compile and format each
complete program.

### A simple API needs only a summary

```silk,ignore
/// Returns the number of initialized elements in `self`.
```

This comment documents `Vector.length`. The signature gives the remaining information.

### Details explain ownership

````silk,ignore
/// Returns the present value. Returns `fallback` if `self` is absent.
///
/// # When to use
///
/// Use this function when absence is valid and the caller has a fallback value.
///
/// # Details
///
/// The absent case consumes `fallback`. The present case drops `fallback`. This function returns
/// one owned value and drops the other value.
///
/// # Examples
///
/// ## Use a present and an absent value
///
/// ```silk
/// import silk.option { Option }
///
/// pub fn main() -> i32 {
///   let present = Option<i32>.some(7)
///   let absent = Option<i32>.none()
///   let first = move present
///     |> Option<i32>.unwrapOr(0)
///   let second = move absent
///     |> Option<i32>.unwrapOr(5)
///   if first + second != 12 {
///     let mismatch = 1 / 0
///   }
///   return 0
/// }
/// ```
````

This comment documents `Option.unwrapOr`. The example imports the matching `Option` actor and uses
an owned value pipeline.

### Gotchas state a trap condition

````silk,ignore
/// Copies the element at `index` and returns it.
///
/// # When to use
///
/// Use this function when `T` is `Copy` and `index` is valid.
///
/// # Details
///
/// This function copies the element. It does not change the vector.
///
/// # Gotchas
///
/// `index` must be less than [`length`]. Otherwise, the program traps. Use [`asSlice`] to borrow
/// an element that is not `Copy`.
///
/// # Examples
///
/// ## Get the second vector element
///
/// ```silk
/// import silk.allocator { Allocator, OutOfMemoryError }
///
/// import silk.effect { Effect }
///
/// import silk.usize
///
/// import silk.vector { Vector }
///
/// pub effect fn main() -> ()
/// ! OutOfMemoryError {
///   let mut allocator = Allocator.systemAllocatorProvider()
///   let mut values = Vector<i32>.make()
///   let first = run Vector<i32>.append(&mut values, 10)
///     |> Effect.provideMut<Allocator>(&mut allocator)
///   let second = run Vector<i32>.append(&mut values, 20)
///     |> Effect.provideMut<Allocator>(&mut allocator)
///   let value = Vector<i32>.get(&values, usize.ONE)
///   if value != 20 {
///     let mismatch = 1 / 0
///   }
///   return ()
/// }
/// ```
````

This comment documents `Vector.get`. The borrow uses a direct call. The Effect values use a pipe.

## Common failures

Reject or revise a comment that:

- omits a `//!` header from a public module;
- omits documentation from a public member;
- translates only the declaration into prose;
- requires another comment to make the summary understandable;
- includes each optional heading without useful content;
- does not comply with ASD-STE100;
- describes an API as safe without a precise safety boundary;
- states that an operation fails without a stable failure condition;
- exposes a private helper or incidental implementation detail;
- has an example that does not show its result;
- contains pseudocode, hidden setup, or invalid Silk;
- contains a broken, ambiguous, or irrelevant symbol link;
- removes useful context from an operation name;
- uses nested calls when a valid pipe is clearer;
- uses a toy example that hides the distinctive behavior;
- copies one explanation across a complete API family;
- claims behavior that implementation and tests do not support; or
- has correct grammar but does not help the reader select and use the API.

## Authoring and review workflow

Documentation is part of the public contract. Develop it from the same evidence as code.

1. Read the declaration and implementation.
2. Inspect tests, real call sites, and related APIs.
3. Write the `//!` header for a public module.
4. Write a standalone summary for each public member.
5. Add only the sections that teach selection, behavior, hazards, or use.
6. Check each behavioral statement against implementation and tests.
7. Check the text against ASD-STE100.
8. Check that each symbol link resolves to one public target.
9. Classify each example as a complete program or a statement sequence.
10. Extract each complete program. Put each statement sequence in a minimal complete program.
11. Run `silk check` and `silk format --check` for each extracted program.
12. Run each example that has executable behavior.
13. Generate the reference documentation.
14. Inspect spacing, wrapping, links, headings, and code blocks.
15. Review the comment as a reader who arrived directly at the symbol.

When implementation, tests, and prose disagree, do not guess. Resolve the public contract before
publication.

## Review checklist

- [ ] The summary is one short, standalone paragraph.
- [ ] Each public module starts with a complete `//!` header.
- [ ] Each public member has its own doc comment.
- [ ] The comment explains the contract and does not restate the signature.
- [ ] Optional sections are useful and use the standard order.
- [ ] `# When to use` gives selection guidance.
- [ ] `# Details` gives observable behavior or a useful mental model.
- [ ] `# Gotchas` gives concrete triggers and results.
- [ ] All text complies with ASD-STE100 Issue 9.
- [ ] The comment contains all information needed for correct use.
- [ ] Each symbol link resolves and has useful link text.
- [ ] Links improve selection, understanding, or navigation.
- [ ] Each example has a specific title and observable result.
- [ ] Each example is a complete program or a legal statement sequence with defined context.
- [ ] Complete programs are preferred and contain all imports and setup.
- [ ] Each operation name has useful context, such as `Vector.get`.
- [ ] Examples use `|>` when the resulting Silk is valid and clear.
- [ ] Each example passes `silk check` and `silk format --check`.
- [ ] Each executable example runs successfully.
- [ ] Terms, names, defaults, and failure conditions match implementation.
- [ ] A related API appears only when it helps the reader.
- [ ] The rendered comment is easy to scan in an editor and generated reference page.

Use canonical import names in every example, including inline snippets and comments. Select the
standard-library owner (`import silk.pointer { Pointer }`) and import primitive modules without an
alias (`import silk.usize`). Reserve aliases for actual collisions or examples explicitly teaching
alias syntax. Prefer more specific declaration names before introducing a collision alias.
