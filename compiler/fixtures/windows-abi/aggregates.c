// Independent Win64 C ABI oracle; no platform headers or runtime required.
typedef struct { unsigned char x; } Byte;
typedef struct { unsigned short x; } Short;
typedef struct { float x; } Float;
typedef struct { int x, y; } Pair;
typedef struct { unsigned char x[5]; } Five;
typedef struct { double x, y; } Doubles;
typedef struct { } Empty;
typedef float V4 __attribute__((vector_size(16)));
typedef float V8 __attribute__((vector_size(32)));
typedef float V16 __attribute__((vector_size(64)));
typedef struct { V4 x; } Wrapped;
_Static_assert(sizeof(Empty) == 4, "Clang's MS C empty-record extension is not a zero-size Silk value");

Byte byte_identity(Byte x) { return x; }
Short short_identity(Short x) { return x; }
Float float_identity(Float x) { return x; }
Pair pair_identity(Pair x) { return x; }
Five five_identity(Five x) { return x; }
Doubles doubles_identity(Doubles x) { return x; }
Empty empty_identity(Empty x) { return x; }
V4 vector_identity(V4 x) { return x; }
V8 wide_identity(V8 x) { return x; }
V16 widest_identity(V16 x) { return x; }
Wrapped wrapped_identity(Wrapped x) { return x; }
extern int consume(Doubles x, V4 y);
int call_copies(Doubles x, V4 y) { return consume(x, y); }
