# Raga

Language support for Raga (`.raga`): highlighting, snippets, and an analyzer that infers types and helps while you type.

The analyzer checks code against the rules of the language while you type. It is separate from the compiler (`ragac`, in the `raga` repository), and it does not compile or run code.

## What it does

- **Type inference** for primitives, non-primitive values, generics, collections, pointers, `Optional` and `Result`,
  functions, methods, callbacks and trailing blocks. Hover any name to see its type and its documentation comment.
- **Completion**
  - after a dot: the fields, properties and methods of structs, classes (with inheritance, traits and interfaces), enums,
    tagged unions, `String`, `List`, `Array`, `Map`, `Set`, `Tuple`, `Optional`, `Result`, pointers and imported modules
  - variables, functions and types that are visible at the cursor, built-in functions, primitive types and keywords
  - the field names of a struct or class being created, and the parameter names of a call (`Point(x = ...)`)
  - the variants after `case (`, the modifiers inside `[method(...)]` (`Visibility.`, `Inheritance.`, `Ownership.` and their members), and file paths inside `import("...")`
- **Classes**: methods are `const name = method(...) { }` with overloads chained after the closing brace, fields are plain
  declarations (`String name = ""`), accessors are `const marks = get { } set |value| { }`, and `[method(...)]`,
  `[field(...)]`, `[accessor(...)]`, `[get(...)]`, `[set(...)]` modifiers are checked. The modifiers are members of three
  enums, not keywords: `Visibility` (Public, Protected, Private), `Inheritance` (Final, Abstract, Virtual, Override) and
  `Ownership` (Instance, Static), written like `[method(Visibility.Private, Ownership.Static)]`. A static member is reached
  on the class, a static method has no `this` and cannot use instance members.
- **Map**: `Map<K, V>` takes two types, a hash table under the hood. A key is a primitive value or a `String`: a struct, class,
  collection, enum or union as the key is reported (key by a text or a number built from the fields). `Map("ann", 31, "bob", 27)`
  infers `Map<String, i32>`, and `Map<i32>` with one type is reported.
- **Errors**: `IError` is the built-in interface (`String message`, `i32 code`) and `Error` is the built-in class that implements it,
  so `Error(message = "boom", code = 2)` is an ordinary creation and your own error is a class that implements `IError` or extends
  `Error`. `throw` takes only those, `catch |e|` gives an `IError` (`e.message`, `e.code`, `e.is<T>()`, `e.as<T>()`), and
  `implements(Error)` is reported ("Error is a class: write implements(IError) or extends(Error)").
- **return, break and continue are calls**: `return(value)`, `return()`, `break()`, `continue()`. The parentheses are always
  written, a word alone is reported ("break is a call: write break()"), and `return` takes a block as its one argument without
  parentheses (`return { 1, 2 }`, `return |x| { }`). `break` and `continue` take an optional number of loops to leave besides the
  innermost one: `break()` is `break(0)`, `break(1)` leaves two loops, `continue(1)` goes to the next pass of the loop around. The number
  is a whole number written in the code, and a number larger than the loops around, a negative one, and a name are reported.
- **Watching the disk**: a change to `raga.project`, or to any `.raga` file outside the editor, is picked up without a reload.
  A generic call whose arguments must share a type (`Math.max(1, 2.5)`) and a block that names more values than its callback
  gives (`or_else |why, more|`) are reported.
- **Generic functions as values**: `identity<i32>` is a function value of type `Function<[i32], i32>` that can be passed, kept and
  returned, a bare generic name is a value only where a function type is expected, and anywhere else it is reported.
- **Memory**: every value is owned by its name and assignment copies it, so there is no `clone` and no `equals`. Sharing is a
  pointer: `addr(x)` gives a `ptr<T>` of a `let` variable (a `const`, a parameter and a temporary value have no address),
  `p.*` is the value, and `&` is only the bitwise and (`&x` is reported with a hint to write `addr(x)`). A field is reached
  through a pointer with `.*` too, `p.*.x`, and `p.x` is reported. `const` makes the whole value read-only: assigning a field of a
  `const` or of a parameter, and calling `push`, `set`, `add`, `remove` and the like on one, is reported. `items.at(i)` gives a
  `ptr<T>` to an element, `get(i)` a copy. `==` is defined for the primitives, `ptr<T>`, `String` (by its text), enum members and a
  type that declares `[operator(Op.Eq)]`; on any other value it is reported. A class stored in a variable of its base class
  or of an interface would lose its fields, so it is reported ("point at it instead, `ptr<People>`"). `alloc<T>(n)`, `free(p)`,
  `sizeof<T>()` and `Type.from_raw(p)` are the manual memory functions.
- **Operators**: `[operator(Op.Add)]` is checked on functions, struct methods and class methods: the member must exist in `Op`, and a
  binary operator takes two values (a function) or one besides the object (a method), a unary one takes one or none.
- **Trailing blocks**: the block after a call is its last argument written in place. The type of the last parameter decides what
  it is: a function type takes a function body (`|n| { return(n) }`), an `Array<T>` takes its values (`{ 1, 2, 3 }`, each one checked
  against `T`), and a struct takes one `name = value` line per field (every field once, any order, each value checked against
  its field, a missing, unknown or repeated field is reported). Any other last parameter, a variadic one, one already given
  inside the parentheses (also when it was given by position), a `|names|` on an `Array` or struct block, and a creation such as
  `Point(...) { }` report an error that says where the value goes instead. The same holds for a clause of a chain
  (`begin { } headers { "a", "b" }`), because it is a call of a method. The declaration decides what `{ }` is: a function with no
  parameters and a struct with no fields look the same, so the type of the last parameter is the only thing that tells them apart.
- **Element types of a collection literal**: when a type is asked for (`Array<i32>`, `List<String>`, as a parameter, a declared variable or a trailing block), each element is checked against it, so `tally("scores") { 'f' }` reports `char is not i32`.
- **Trailing blocks and chains in completion**: after the `)` of a call whose last parameter is a callback, completion offers the
  block that fills it, with the names the callback gives (`|result| { }`, and `return(...)` when the callback gives a value);
  for an `Array` it offers `{ }` and for a struct it offers a block with one line per field (`name = `, `size = `);
  after a space it opens by itself. After the `}` of a block on the same line, it offers the next clauses of the chain, the
  methods of what the call gave back whose last parameter is a callback (`on_error |error| { }`, `cleanup { }`).
- **Attribute call hooks on methods**: an attribute limited to methods with `[on(Kind.Method)]` has a call block with four parameters,
  `|target, receiver, args, next|`, and any other attribute has three. A wrong count is reported.
- **Library**: the built-in types `Math` (rounding, trigonometry, `Math.pi`), `System`, `File`, `Time` and `Random`, the String
  methods `index_of`, `get`, `slice`, `split`, `trim`, `replace`, `lower`, `String.format` and `$` with C format checks, and
  `import` that must be given a path or library name written in the code. Calls to built-in methods have their arguments checked.
- **Closures**: a function can be defined anywhere, also inside another function or block, and it may use the locals,
  parameters and loop names around it. They are shared with the closure, not copied, so a `let` that a closure changes is
  changed for everyone, and hover marks such a name as "used by a closure". A closure does not keep its variables alive, so returning a function that
  uses the variables of the function that returns it is reported ("they are gone when it ends").
  Function values (`Function<[i32], i32>`) can be returned, kept in variables, struct and class fields, Lists and Maps,
  and called right away with `f()()` or `fns.get(0)(3)`. A function has no `==`. A trailing block is a closure too.
  The editor types them, checks the arguments of a stored function and the return types, and reports a name used before
  its declaration, an assignment to a captured `const` or parameter, and functions of different types in one return.
- **Attributes** come in three patterns: metadata only (`const note = attribute(String text)`, read with
  `attributes_of`), a build hook (`... |target, text| { }`, runs once per use while the program is built) and a call hook
  (`} call |target, args, next| { return(next(args)) }`, runs on every call). Block parameters are always named in the
  pipes (`target` first, then the declared parameters in order, or `...rest` for an attribute without parameters), nothing
  is in scope by magic and the number of names is checked.
- **Calls and names**: a call has parentheses, `double(base)`, `answer()`, `nums.push(x)`. A name without parentheses is the function
  itself, never a call, whether the function takes parameters or not: `double(answer)` passes the function, `double(answer())` passes what
  it gives, and a name used as a whole statement (`answer`) is reported ("answer is a function and this does not call it").
  The one exception is a block: `{` or `|x| {` after a name is a trailing block that is the one argument (`run { }`,
  `repeat |i| { }`, and `show { x = 1 }` for a function whose only parameter is a struct). A name after a name is not an argument
  without parentheses and reports a hint (`double base` is an error, write `double(base)`), and so does a written-out value
  (`double 5`, write `double(5)`). `double -x` is the subtraction `double - x`, and a name followed by a block when it is not a
  function reports "x is not a function, it cannot take a block".
- **Chains without dots after a block**: calls that return values are chained with a dot, `user().select().limit(1)`. When the last
  argument of a call is written as a block (a callback, an Array or a struct) a dot after the closing brace would look strange, so the
  next name follows the brace on the same line: `user { } select { } limit (1)`. Each step is a call of a method of what the step before
  it gave back, with its block as the last argument, so the arguments, the block and the order of the steps are checked against the
  methods of the returned type.
- **Signature help** for functions, methods (every overload) and struct or class creation.
- **Struct and union fields with defaults** (`f64 x = 0.0`, `struct { f64 w = 1.0, f64 h = 1.0 }`): a field without a default must be given when the value is created, `Point()` is valid when every field has one, and `Bits32()` starts a union as its first field when that field has a default. Hover, signature help and named-argument completion show the defaults.
- **Go to definition** (also into other files and through `import`), **find references**, **rename**, **outline**.
- **Inlay hints**: the inferred type after `const` and `let` names, loop names and the names of a trailing block.
- **Diagnostics** while you type: undeclared names, unknown fields and methods, wrong argument counts, struct creation
  rules, assigning to a `const`, a literal of the wrong kind or too large for its type, `null` for a non-pointer,
  `return` outside a function, built-in names declared again, a type that holds itself directly, `export { a, b }` (a block of names, the last statement of a file) and `import`
  mistakes, and modules that import each other.

Naming style (snake_case, camelCase, Capitalized) is a convention and is never reported.

## Settings

| Setting | Default | |
|---|---|---|
| `raga.inlayHints.enabled` | `true` | show inferred types after names |
| `raga.diagnostics.enabled` | `true` | report mistakes while typing |

## How it is built

`src/lexer.js` and `src/parser.js` read the code into a tree and never fail on half-typed code.
`src/prelude.js` describes the built-in types and functions in Raga itself (it follows `raga/templates/11-standard-library.raga`).
`src/analyzer.js` binds names and infers types, `src/queries.js` answers the editor, `src/workspace.js` loads imported files.
`extension.js` is the only file that uses the VS Code API.
- **Bodies hold definitions, not bare names.** An enum member is `const Red = 0` (always with an integer value, no two the same),
  a variant named from outside is `const Square = Square`, and members of a struct, enum or union are separated by a new line
  or `;`, never a comma (`struct { f64 w; f64 h }`). The old forms report what to write instead.
