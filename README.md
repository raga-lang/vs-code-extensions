# Raga

Language support for Raga (`.raga`): highlighting, snippets, and an analyzer that infers types and helps while you type.

## What it does

- **Type inference** for primitives, non-primitive values, generics, collections, pointers, `Optional` and `Result`,
  functions, methods, callbacks and trailing blocks. Hover any name to see its type and its documentation comment.
- **Completion**
  - after a dot: the fields, properties and methods of structs, classes (with inheritance, traits and interfaces), enums,
    tagged unions, `String`, `List`, `Array`, `Map`, `Set`, `Tuple`, `Optional`, `Result`, `Weak`, pointers and imported modules
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
- **break and continue** take an optional number of loops to leave besides the innermost one: `break` is `break 0`, `break 1`
  leaves two loops, `continue 1` goes to the next pass of the loop around. The number is a whole number written in the code, and a
  number larger than the loops around, a negative one, and a name are reported.
- **Watching the disk**: a change to `raga.project`, or to any `.raga` file outside the editor, is picked up without a reload.
  A generic call whose arguments must share a type (`Math.max(1, 2.5)`) and a block that names more values than its callback
  gives (`or_else |why, more|`) are reported.
- **Generic functions as values**: `identity<i32>` is a function value of type `function(i32) i32` that can be passed, kept and
  returned, a bare generic name is a value only where a function type is expected, and anywhere else it is reported.
- **Operators**: `[operator(Op.Add)]` is checked on functions, struct methods and class methods: the member must exist in `Op`, and a
  binary operator takes two values (a function) or one besides the object (a method), a unary one takes one or none.
- **Trailing blocks and chains in completion**: after the `)` of a call whose last parameter is a callback, completion offers the
  block that fills it, with the names the callback gives (`|result| { return }`, and `return` when the callback gives a value);
  after a space it opens by itself. After the `}` of a block on the same line, it offers the next clauses of the chain, the
  methods of what the call gave back whose last parameter is a callback (`on_error |error| { }`, `cleanup { }`).
- **Attribute call hooks on methods**: an attribute limited to methods with `[on(Kind.Method)]` has a call block with four parameters,
  `|target, receiver, args, next|`, and any other attribute has three. A wrong count is reported.
- **Library**: the built-in types `Math` (rounding, trigonometry, `Math.pi`), `System`, `File`, `Time` and `Random`, the String
  methods `index_of`, `get`, `slice`, `split`, `trim`, `replace`, `lower`, `String.format` and `$` with C format checks, and
  `import` that must be given a path or library name written in the code. Calls to built-in methods have their arguments checked.
- **Closures**: a function can be defined anywhere, also inside another function or block, and it may use the locals,
  parameters and loop names around it. They are shared with the closure, not copied, so a `let` that a closure changes is
  changed for everyone, and hover marks such a name as "captured by a closure: lives on the heap while a closure uses it".
  Function values (`function(i32) i32`) can be returned, kept in variables, struct and class fields, Lists and Maps,
  compared with `==` and called right away with `f()()` or `fns.get(0)(3)`. A trailing block is a closure too.
  The editor types them, checks the arguments of a stored function and the return types, and reports a name used before
  its declaration, an assignment to a captured `const` or parameter, and functions of different types in one return.
- **Attributes** come in three patterns: metadata only (`const note = attribute(String text)`, read with
  `attributes_of`), a build hook (`... |target, text| { }`, runs once per use while the program is built) and a call hook
  (`} call |target, args, next| { return next(args) }`, runs on every call). Block parameters are always named in the
  pipes (`target` first, then the declared parameters in order, or `...rest` for an attribute without parameters), nothing
  is in scope by magic and the number of names is checked.
- **Calls without parentheses**: after a function name the next token on the same line decides. `{` or `|x| {` is a trailing
  block with no argument (`run { }`, `repeat |i| { }`). A number (`double 5`, `double -5`), a char, `true`/`false`, or a name
  with its `.members` and calls (`show user.name`, `double sum(xs)`, `double sum xs`) is the one argument. A String, List, Array,
  Tuple, `null` or `!x` is not a bare argument and reports a hint to use parentheses, and a call with a trailing block keeps its
  parentheses. `f -x` and `f - x` stay subtraction, `f -5` is `f(-5)`, and a name followed by an argument that is not a function
  reports "x is not a function, it cannot take an argument". A bare name alone is still the function value.
- **Signature help** for functions, methods (every overload) and struct or class creation.
- **Struct and union fields with defaults** (`f64 x = 0.0`, `struct { f64 w = 1.0, f64 h = 1.0 }`): a field without a default must be given when the value is created, `Point()` is valid when every field has one, and `Bits32()` starts a union as its first field when that field has a default. Hover, signature help and named-argument completion show the defaults.
- **Go to definition** (also into other files and through `import`), **find references**, **rename**, **outline**.
- **Inlay hints**: the inferred type after `const` and `let` names, loop names and the names of a trailing block.
- **Diagnostics** while you type: undeclared names, unknown fields and methods, wrong argument counts, struct creation
  rules, assigning to a `const`, a literal of the wrong kind or too large for its type, `null` for a non-pointer,
  `return` outside a function, built-in names declared again, a type that holds itself directly, `export(a, b)` (a function, the last statement of a file) and `import`
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
