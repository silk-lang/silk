typedef float Vec __attribute__((vector_size(16)));
typedef unsigned UVec __attribute__((vector_size(16)));
struct Bits { Vec a; UVec b; };
struct Bits c_bits(struct Bits v) { v.a += (Vec){1,1,1,1}; v.b += (UVec){2,2,2,2}; return v; }
extern struct Bits s_bits(struct Bits);
struct One { Vec value; };
struct Pair { Vec a, b; };
struct Quad { Vec a, b, c, d; };
struct One c_one(struct One v) { v.value += (Vec){1,1,1,1}; return v; }
struct Pair c_pair(struct Pair v) { struct Pair r = {v.b, v.a}; return r; }
struct Quad c_quad(struct Quad v) { struct Quad r = {v.d,v.c,v.b,v.a}; return r; }
struct Pair c_vector_callback(struct Pair (*callback)(struct Pair), struct Pair v) { return callback(v); }
extern struct One s_one(struct One);
extern struct Pair s_pair(struct Pair);
extern struct Quad s_quad(struct Quad);
int c_vector_exports(void) {
  Vec a = {1,2,3,4}, b = {5,6,7,8};
  struct Bits bits = s_bits((struct Bits){a, (UVec){10,20,30,40}});
  struct One one = s_one((struct One){a});
  struct Pair pair = s_pair((struct Pair){a,b});
  struct Quad quad = s_quad((struct Quad){a,b,a,b});
  for (int i=0; i<4; ++i)
    if (bits.a[i] != a[i]+1 || bits.b[i] != (unsigned)(10*(i+1)+2) || one.value[i] != a[i]+1 || pair.a[i] != b[i] || pair.b[i] != a[i]
        || quad.a[i] != b[i] || quad.b[i] != a[i] || quad.c[i] != b[i] || quad.d[i] != a[i]) return 1;
  return 0;
}
