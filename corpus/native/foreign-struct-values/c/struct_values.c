#include <stdint.h>
struct Byte { uint8_t a; };
struct Scalar { double a; };
struct Five { uint8_t a[5]; };
struct Words { int64_t a, b; };
struct Mixed { double a; int32_t b; };
struct Reverse { int32_t a; double b; };
struct Floats { float a[3]; };
struct Doubles { double a, b, c, d; };
struct Nested { struct Floats a; };
struct Large { int64_t a, b, c; };
struct CallbackInfo {
  void *nextInChain;
  uint32_t mode;
  void (*callback)(uint32_t, uint32_t *);
  uint32_t *userdata;
};
struct CallbackEnvelope { struct CallbackInfo info; };
static struct CallbackInfo pending;

void c_register_deferred(struct CallbackEnvelope envelope) {
  pending = envelope.info;
}
void c_register_direct(void (*callback)(uint32_t, uint32_t *), uint32_t *userdata) {
  pending = (struct CallbackInfo){0, 7, callback, userdata};
}
int c_process_deferred(void) {
  if (!pending.callback) return 0;
  struct CallbackInfo current = pending;
  pending.callback = 0;
  current.callback(current.mode, current.userdata);
  return 1;
}

struct Scalar c_scalar(struct Scalar v) { v.a += 1.25; return v; }
struct Byte c_byte(struct Byte v) { v.a += 1; return v; }
struct Five c_five(struct Five v) { struct Five r = {{v.a[4], v.a[3], v.a[2], v.a[1], v.a[0]}}; return r; }
struct Words c_words(struct Words v) { v.a += 1; v.b += 2; return v; }
struct Mixed c_mixed(struct Mixed v) { v.a += 1.5; v.b += 2; return v; }
struct Reverse c_reverse(struct Reverse v) { v.a += 2; v.b += 1.5; return v; }
struct Floats c_floats(struct Floats v) { v.a[0] += 1; v.a[1] += 2; v.a[2] += 3; return v; }
struct Doubles c_doubles(struct Doubles v) { v.a += 1; v.b += 2; v.c += 3; v.d += 4; return v; }
struct Nested c_nested(struct Nested v) { v.a = c_floats(v.a); return v; }
struct Large c_large(struct Large v) { volatile struct Large *p = &v; p->a += 1; p->b += 2; p->c += 3; return v; }
int64_t c_registers(int64_t a, int64_t b, int64_t c, int64_t d, int64_t e, struct Words v, int64_t tail) {
  return a + b + c + d + e + v.a + v.b + tail;
}
double c_mixed_registers(int64_t a, int64_t b, int64_t c, int64_t d, int64_t e, int64_t f, struct Mixed v, double tail) {
  if (a + b + c + d + e + f != 21 || v.b != 17) return -1;
  return v.a + tail;
}
struct Large c_sret_registers(int64_t a, int64_t b, int64_t c, int64_t d, int64_t e, struct Words v, int64_t tail) {
  struct Large r = {a + b + c + d + e, v.a + v.b, tail}; return r;
}
int c_callbacks(struct Mixed (*mixed)(struct Mixed), struct Large (*large)(struct Large)) {
  struct Mixed m = mixed((struct Mixed){2.25, -7});
  struct Large l = large((struct Large){3, 5, 7});
  return m.a != 3.75 || m.b != -5 || l.a != 4 || l.b != 7 || l.c != 10;
}
#define EXPORT(T, name) extern struct T s_##name(struct T);
EXPORT(Scalar, scalar) EXPORT(Byte, byte) EXPORT(Five, five) EXPORT(Words, words) EXPORT(Mixed, mixed)
EXPORT(Reverse, reverse) EXPORT(Floats, floats) EXPORT(Doubles, doubles)
EXPORT(Nested, nested) EXPORT(Large, large)
extern int64_t s_registers(int64_t, int64_t, int64_t, int64_t, int64_t, struct Words, int64_t);
extern double s_mixed_registers(int64_t, int64_t, int64_t, int64_t, int64_t, int64_t, struct Mixed, double);
extern struct Large s_sret_registers(int64_t, int64_t, int64_t, int64_t, int64_t, struct Words, int64_t);
double c_float_stack(double a, double b, double c, double d, double e, double f, double g, double h, float small, struct Floats value, double tail) {
  if (a+b+c+d+e+f+g+h != 36 || small != 9.5f || value.a[0] != 10.5f || value.a[1] != 11.5f || value.a[2] != 12.5f) return -1;
  return tail;
}
extern double s_float_stack(double a, double b, double c, double d, double e, double f, double g, double h, float small, struct Floats value, double tail);
int c_exports(void) {
  struct Scalar scalar = s_scalar((struct Scalar){4.5});
  struct Byte b = s_byte((struct Byte){200});
  struct Five f = s_five((struct Five){{1,2,3,4,5}});
  struct Words w = s_words((struct Words){-20000000000LL,30000000000LL});
  struct Mixed m = s_mixed((struct Mixed){2.25,-7});
  struct Reverse r = s_reverse((struct Reverse){-7,2.25});
  struct Floats fs = s_floats((struct Floats){{2.5f,4.5f,6.5f}});
  struct Doubles ds = s_doubles((struct Doubles){2.5,4.5,6.5,8.5});
  struct Nested n = s_nested((struct Nested){{{2.5f,4.5f,6.5f}}});
  struct Large original = {3,5,7}, l = s_large(original);
  struct Large sr = s_sret_registers(1,2,3,4,5,(struct Words){11,13},17);
  return scalar.a != 5.75 || b.a != 201 || f.a[0] != 5 || f.a[4] != 1 || w.a != -19999999999LL || w.b != 30000000002LL
    || m.a != 3.75 || m.b != -5 || r.a != -5 || r.b != 3.75
    || fs.a[0] != 3.5f || fs.a[1] != 6.5f || fs.a[2] != 9.5f
    || ds.a != 3.5 || ds.b != 6.5 || ds.c != 9.5 || ds.d != 12.5
    || n.a.a[0] != 3.5f || n.a.a[2] != 9.5f || l.a != 4 || l.b != 7 || l.c != 10
    || original.a != 3 || original.b != 5 || original.c != 7
    || s_registers(1,2,3,4,5,(struct Words){11,13},17) != 56
    || s_mixed_registers(1,2,3,4,5,6,(struct Mixed){2.25,17},3.5) != 5.75
    || s_float_stack(1,2,3,4,5,6,7,8,9.5f,(struct Floats){{10.5f,11.5f,12.5f}},13.5) != 13.5
    || sr.a != 15 || sr.b != 24 || sr.c != 17;
}
