'use strict';

// The built-in types and functions of Raga, written in Raga itself.
// The analyzer reads this text with the same parser as user code, so a built-in type is described in the same way as
// your own. It follows templates/11-standard-library.raga: nothing here is invented.
// A comment on the line above a name is its documentation, shown in hover and completion.

module.exports = `
// A piece of text. A String cannot be changed, and == compares references: use equals to compare the text.
const String = struct {
    // The number of characters.
    const len = function() usize { }
    // A new String in upper case.
    const upper = function() String { }
    // True when the part is inside this String.
    const contains = function(String part) bool { }
    // True when both Strings have the same text.
    const equals = function(String other) bool { }
    // The parts between the separator, as a List of new Strings.
    const split = function(String separator) List<String> { }
    // A new String without the spaces at both ends.
    const trim = function() String { }
    // A new String where every match of from is replaced by to.
    const replace = function(String from, String to) String { }
    // A new String in lower case.
    const lower = function() String { }
    // The position of the first match of part, throws when part is not inside: check contains first.
    const index_of = function(String part) usize { }
    // The character at the position, throws when there is none.
    const get = function(usize index) char { }
    // A new String with the characters from start up to, not including, end. Throws when a position is outside.
    const slice = function(usize start, usize end) String { }
    // A new String: a followed by b.
    [method(Ownership.Static)]
    const join = function(String a, String b) String { }
    // A new String made from a format with % specifiers, as printf: %d %u %x %X %o %c %f %e %g %s %p and %%.
    [method(Ownership.Static)]
    const format = function(String format, Any ...values) String { }
}

// A fixed size sequence of values of one type. An element can be replaced, but the size cannot change.
const Array = struct<T> {
    // The element at the position, throws when it does not exist.
    const get = function(usize index) T { }
    // Replaces the element at the position.
    const set = function(usize index, T value) { }
    // The number of elements.
    const len = function() usize { }
    // True when an element is == to the value.
    const contains = function(T value) bool { }
}

// A growable sequence of values of one type.
const List = struct<T> {
    // The element at the position, throws when it does not exist.
    const get = function(usize index) T { }
    // Replaces the element at the position.
    const set = function(usize index, T value) { }
    // The number of elements.
    const len = function() usize { }
    // True when an element is == to the value.
    const contains = function(T value) bool { }
    // Adds a value at the end.
    const push = function(T value) { }
    // Removes and gives the last element, throws when the List is empty.
    const pop = function() T { }
    // Adds a value at the front.
    const unshift = function(T value) { }
    // Removes and gives the first element, throws when the List is empty.
    const shift = function() T { }
    // A new Array with the elements of the List, in the same order.
    const to_array = function() Array<T> { }
    // Puts a value in at the position, later elements move up.
    const insert = function(usize index, T value) { }
    // Removes the element at the position and gives it back, throws when there is none.
    const remove = function(usize index) T { }
    // Turns the List around, in place.
    const reverse = function() { }
    // Sorts the List in place with a callback: negative when a comes first, 0 when equal, positive otherwise.
    const sort = function(function(T, T) i32 compare) { }
}

// A fixed number of values, each slot with its own type. The position of get and set is a literal.
const Tuple = struct {
    // The value in the slot.
    const get = function(usize slot) { }
    // Replaces the value in the slot.
    const set = function(usize slot, Any value) { }
    // The number of slots.
    const len = function() usize { }
}

// A collection of values without duplicates.
const Set = struct<T> {
    // Adds a value, a value that is already there is not added.
    const add = function(T value) { }
    // Removes a value.
    const remove = function(T value) { }
    // True when the value is in the Set.
    const contains = function(T value) bool { }
    // The number of values.
    const len = function() usize { }
}

// Keys and values. The keys can be of any type and are kept in a hash table.
// A hash table. The key K is a primitive value or a String, any other type is reported; the values have one type V.
const Map = struct<K, V> {
    // Adds or replaces the value of a key.
    const set = function(K key, V value) { }
    // The value of a key, throws when the key is not there.
    const get = function(K key) V { }
    // True when the key is there.
    const has = function(K key) bool { }
    // Removes a key and its value.
    const remove = function(K key) { }
    // The number of keys.
    const len = function() usize { }
    // The keys, in no fixed order.
    const keys = function() Array<K> { }
    // The values, in the order of keys().
    const values = function() Array<V> { }
    // A new Map with the same keys and values.
    const clone = function() Map<K, V> { }
}

// A value or nothing.
const Optional = union<T> {
    // A value.
    const Some = struct { T value }
    // Nothing.
    const None = struct { }
    // The value, throws an Error when there is none.
    const unwrap = function() T { }
    // The same as unwrap, named for giving up.
    const or_throw = function() T { }
    // The value, or what the block gives when there is none.
    const or_else = function(function() T replace) T { }
}

// A value or the reason it failed.
const Result = union<T, E> {
    // The value.
    const Ok = struct { T value }
    // The reason.
    const Err = struct { E reason }
    // The value, throws an Error with the reason when it is an Err.
    const unwrap = function() T { }
    // The value, or the fallback when it is an Err.
    const unwrapOr = function(T fallback) T { }
    // The same as unwrap, named for giving up.
    const or_throw = function() T { }
    // The value, or what the block gives for the reason when it is an Err.
    const or_else = function(function(E reason) T replace) T { }
}

// A weak reference: it does not keep the value alive.
const Math = class {
    // The ratio of the circumference of a circle to its diameter.
    [field(Ownership.Static)]
    f64 pi = 3.141592653589793
    // The base of natural logarithms.
    [field(Ownership.Static)]
    f64 e = 2.718281828459045
    // The size of a number without its sign, for any signed integer or float.
    [method(Ownership.Static)]
    const abs = method<T>(T value) T { }
    // The smaller of two numbers of the same type.
    [method(Ownership.Static)]
    const min = method<T>(T a, T b) T { }
    // The larger of two numbers of the same type.
    [method(Ownership.Static)]
    const max = method<T>(T a, T b) T { }
    // base to the power of exponent.
    [method(Ownership.Static)]
    const pow = method(f64 base, f64 exponent) f64 { }
    // The square root.
    [method(Ownership.Static)]
    const sqrt = method(f64 value) f64 { }
    // The largest whole number that is not above the value, as an f64.
    [method(Ownership.Static)]
    const floor = method(f64 value) f64 { }
    // The smallest whole number that is not below the value, as an f64.
    [method(Ownership.Static)]
    const ceil = method(f64 value) f64 { }
    // The nearest whole number, halves go away from zero, as an f64.
    [method(Ownership.Static)]
    const round = method(f64 value) f64 { }
    // The value without its decimals, towards zero, as an f64.
    [method(Ownership.Static)]
    const trunc = method(f64 value) f64 { }
    // Sine of an angle in radians.
    [method(Ownership.Static)]
    const sin = method(f64 radians) f64 { }
    // Cosine of an angle in radians.
    [method(Ownership.Static)]
    const cos = method(f64 radians) f64 { }
    // Tangent of an angle in radians.
    [method(Ownership.Static)]
    const tan = method(f64 radians) f64 { }
    // The angle in radians whose sine is the value.
    [method(Ownership.Static)]
    const asin = method(f64 value) f64 { }
    // The angle in radians whose cosine is the value.
    [method(Ownership.Static)]
    const acos = method(f64 value) f64 { }
    // The angle in radians whose tangent is the value.
    [method(Ownership.Static)]
    const atan = method(f64 value) f64 { }
    // The angle in radians of the point (x, y) seen from the origin.
    [method(Ownership.Static)]
    const atan2 = method(f64 y, f64 x) f64 { }
    // e to the power of the value.
    [method(Ownership.Static)]
    const exp = method(f64 value) f64 { }
    // The natural logarithm.
    [method(Ownership.Static)]
    const log = method(f64 value) f64 { }
    // The logarithm to base 10.
    [method(Ownership.Static)]
    const log10 = method(f64 value) f64 { }
}
const System = struct {
    // Ends the program at once with this exit status. A finally block does not run.
    [method(Ownership.Static)]
    const exit = function(i32 code) { }
    // The words after the program name.
    [method(Ownership.Static)]
    const args = function() Array<String> { }
    // The value of an environment variable, or why there is none.
    [method(Ownership.Static)]
    const env = function(String name) Result<String, String> { }
    // The call stack of an error as text, one line for each function that was running when it was thrown.
    [method(Ownership.Static)]
    const trace = function(IError error) String { }
}
const File = struct {
    // The text of the file, or the reason it could not be read.
    [method(Ownership.Static)]
    const read = function(String path) Result<String, String> { }
    // Writes the text to the file and replaces what was there, or gives the reason it could not.
    [method(Ownership.Static)]
    const write = function(String path, String text) Result<bool, String> { }
    // Adds the text at the end of the file, or gives the reason it could not.
    [method(Ownership.Static)]
    const append = function(String path, String text) Result<bool, String> { }
    // True when there is a file or a folder at the path.
    [method(Ownership.Static)]
    const exists = function(String path) bool { }
}
const Time = struct {
    // The milliseconds since 1 January 1970 UTC.
    [method(Ownership.Static)]
    const now = function() i64 { }
}
const Random = struct {
    // A whole number from low up to, not including, high.
    [method(Ownership.Static)]
    const int = function(i32 low, i32 high) i32 { }
    // A float from 0.0 up to, not including, 1.0.
    [method(Ownership.Static)]
    const float = function() f64 { }
    // Makes the following numbers repeat: the same seed gives the same numbers.
    [method(Ownership.Static)]
    const seed = function(u64 value) { }
}
const Weak = struct<T> {
    // Some while the value is alive, None after it was freed.
    const get = function() Optional<T> { }
    // True while the value is alive.
    const alive = function() bool { }
}

// A value of any type.
const Any = struct {
    // The name of the type inside, known when the program runs.
    const typeName = function() String { }
    // True when the type inside is U.
    const is = function<U>() bool { }
    // Some when the type inside is U, None otherwise.
    const as = function<U>() Optional<U> { }
}

// The value that throw raises.
const IError = interface {
    String message
    i32 code
}
const Error = class {
    String message = ""
    i32 code = 0
} implements(IError)

// The numbers of range(from, to).
const Range = struct<T> { }

// Shares names of this file with the files that import it: export(a, b), the last statement of the file.
const export = function() { }

// The value of import(path): its exported names are reached with a dot.
const Module = struct { }

// The modifiers of [class(...)], [method(...)], [field(...)], [accessor(...)], [get(...)] and [set(...)].
const Visibility = enum { const Public = 0; const Protected = 1; const Private = 2 }
const Inheritance = enum { const Final = 0; const Abstract = 1; const Virtual = 2; const Override = 3 }
const Ownership = enum { const Instance = 0; const Static = 1 }

const Kind = enum { const Primitive = 0; const Struct = 1; const Enum = 2; const Union = 3; const Function = 4; const Field = 5; const Heap = 6; const Method = 7 }

const Op = enum {
    const Add = 0; const Sub = 1; const Mul = 2; const Div = 3; const Mod = 4; const Neg = 5; const Not = 6
    const Eq = 7; const Lt = 8; const Le = 9; const Gt = 10; const Ge = 11
    const BitAnd = 12; const BitOr = 13; const BitXor = 14; const BitNot = 15; const Shl = 16; const Shr = 17
}

// What reflect gives for a type.
const TypeInfo = struct {
    String name
    Kind kind
    usize size
    usize alignment
    Array<FieldInfo> fields
    Array<VariantInfo> variants
    Array<AttributeInfo> attributes
}
const FieldInfo = struct {
    String name
    String type_name
    Array<AttributeInfo> attributes
}
const VariantInfo = struct {
    String name
    Array<FieldInfo> fields
}
const AttributeInfo = struct {
    String name
    Array<Any> arguments
}
const BindingInfo = struct {
    String name
    Kind kind
    String type_name
    Array<AttributeInfo> attributes
    // Runs the binding, checking the number and the types of the arguments.
    const invoke = function(Array<Any> arguments) Result<Any, String> { }
}

// Shows a value on its own line.
const print = function(Any value) { }
// Reads one line of input, without the end of line.
const read_line = function() String { }
// Text made from a format with C's % specifiers, the same as String.format: $("hello %s, you are %d", name, age).
const $ = function(String format, Any ...values) String { }
// The number of elements or characters, the same as value.len().
const len = function(Any value) usize { }
// The numbers from from up to but not including to, for loops.
const range = function<T>(T from, T to, T step = 1) Range<T> { }
// Pauses the program.
const sleep = function(u64 milliseconds) { }
// The type of a value, known when the program is built.
const typeof = function(Any value) TypeInfo { }
// The size of a type in bytes.
const sizeof = function<T>() usize { }
// The alignment of a type in bytes.
const alignof = function<T>() usize { }
// Room for count values of a primitive type, filled with zeros.
const alloc = function<T>(usize count = 1) ptr<T> { }
// Gives memory from alloc back. free(null) does nothing.
const free = function<T>(ptr<T> pointer) { }
// Runs the expression while the program is built and keeps the result.
const compile = function<T>(T expression) T { }
// Describes the type T as data.
const reflect = function<T>() TypeInfo { }
// The attributes with that name on a declaration.
const attributes_of = function(Any thing, String name) Array<AttributeInfo> { }
// Reads a field by name.
const get_field = function<T>(ptr<T> pointer, String name) Optional<Any> { }
// Writes a field by name.
const set_field = function<T>(ptr<T> pointer, String name, Any value) Result<bool, String> { }
// The Module of the file at that path, written from the folder of this file, without .raga.
const import = function(String path) Module { }
`;
