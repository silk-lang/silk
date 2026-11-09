#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

void storage_copy_probe(void *, size_t, const int32_t *, size_t, size_t);

int32_t storage_copy_exercise(void) {
  int32_t *values = malloc(4 * sizeof(*values));
  if (!values) return 1;
  /* SealedCore.RawBuffer is the four target-word fields base/count/reclaim/context.
     This is a lowering/ABI fixture, not a source-visible representation promise. */
  uintptr_t header[4] = {(uintptr_t)values, 4, 0, (uintptr_t)values};
  for (int32_t i = 0; i < 4; ++i) values[i] = i + 1;
  storage_copy_probe(header, 1, values, 3, 3);
  if (values[0] != 1 || values[1] != 1 || values[2] != 2 || values[3] != 3) return 2;
  for (int32_t i = 0; i < 4; ++i) values[i] = i + 1;
  storage_copy_probe(header, 0, values + 1, 3, 3);
  if (values[0] != 2 || values[1] != 3 || values[2] != 4 || values[3] != 4) return 3;
  storage_copy_probe(header, 4, values + 4, 0, 0);
  if (values[0] != 2 || values[1] != 3 || values[2] != 4 || values[3] != 4) return 4;
  free(values);
  return 42;
}
