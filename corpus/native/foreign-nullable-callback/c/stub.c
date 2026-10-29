#include <stdint.h>
#include <stddef.h>
typedef void (*Callback)(uint32_t, uint32_t *);
struct CallbackInfo { void *nextInChain; Callback callback; uint32_t *userdata; };
int32_t c_invoke(struct CallbackInfo info) {
  if (info.callback == NULL) return 0;
  info.callback(7, info.userdata);
  return 1;
}
int32_t c_maybe(Callback optional, uint32_t *userdata) {
  if (optional == NULL) return 0;
  optional(11, userdata);
  return 1;
}
