/*
 * Drives the Silk source memory providers across every length up to 40, every source and
 * destination offset modulo eight, and both overlap directions. Each failure returns its own
 * status; success returns 42. Reference results use volatile byte loops, which the C compiler
 * cannot turn back into calls to the providers under test.
 */
#include <stddef.h>
#include <string.h>
#ifdef __APPLE__
#include <strings.h>
#endif

static void *(*volatile copy_bytes)(void *, const void *, size_t) = memcpy;
static void *(*volatile move_bytes)(void *, const void *, size_t) = memmove;
static void *(*volatile fill_bytes)(void *, int, size_t) = memset;
static int (*volatile compare_bytes)(const void *, const void *, size_t) = memcmp;
#ifdef __APPLE__
static void (*volatile zero_bytes)(void *, size_t) = bzero;
#else
extern int bcmp(const void *, const void *, size_t);
static int (*volatile equal_bytes)(const void *, const void *, size_t) = bcmp;
#endif

enum { SIZE = 96, MAX_LENGTH = 40, MAX_OFFSET = 9, MAX_SHIFT = 17 };

static void pattern(volatile unsigned char *buffer, unsigned seed) {
  for (unsigned i = 0; i < SIZE; ++i) buffer[i] = (unsigned char)(i * 29 + seed * 7 + 1);
}

static void duplicate(volatile unsigned char *to, volatile const unsigned char *from) {
  for (unsigned i = 0; i < SIZE; ++i) to[i] = from[i];
}

static int same(volatile const unsigned char *left, volatile const unsigned char *right) {
  for (unsigned i = 0; i < SIZE; ++i)
    if (left[i] != right[i]) return 0;
  return 1;
}

static int sign(int value) { return (value > 0) - (value < 0); }

int main(void) {
  unsigned char source[SIZE], destination[SIZE], expected[SIZE], original[SIZE];
  for (unsigned length = 0; length <= MAX_LENGTH; ++length)
    for (unsigned from = 0; from < MAX_OFFSET; ++from)
      for (unsigned to = 0; to < MAX_OFFSET; ++to) {
        pattern(source, 1);
        pattern(destination, 2);
        duplicate(expected, destination);
        for (unsigned i = 0; i < length; ++i) ((volatile unsigned char *)expected)[to + i] = source[from + i];
        if (copy_bytes(destination + to, source + from, length) != destination + to) return 1;
        if (!same(destination, expected)) return 2;
      }
  for (unsigned length = 0; length <= MAX_LENGTH; ++length)
    for (unsigned from = 0; from < MAX_SHIFT; ++from)
      for (unsigned to = 0; to < MAX_SHIFT; ++to) {
        pattern(destination, 3);
        duplicate(original, destination);
        duplicate(expected, destination);
        for (unsigned i = 0; i < length; ++i) ((volatile unsigned char *)expected)[to + i] = original[from + i];
        if (move_bytes(destination + to, destination + from, length) != destination + to) return 3;
        if (!same(destination, expected)) return 4;
      }
  const int values[] = {0, 90, 255, 0x1a7, -1};
  for (unsigned v = 0; v < sizeof values / sizeof values[0]; ++v)
    for (unsigned length = 0; length <= MAX_LENGTH; ++length)
      for (unsigned at = 0; at < MAX_OFFSET; ++at) {
        pattern(destination, 4);
        duplicate(expected, destination);
        for (unsigned i = 0; i < length; ++i) ((volatile unsigned char *)expected)[at + i] = (unsigned char)values[v];
        if (fill_bytes(destination + at, values[v], length) != destination + at) return 5;
        if (!same(destination, expected)) return 6;
#ifdef __APPLE__
        pattern(destination, 5);
        duplicate(expected, destination);
        for (unsigned i = 0; i < length; ++i) ((volatile unsigned char *)expected)[at + i] = 0;
        zero_bytes(destination + at, length);
        if (!same(destination, expected)) return 7;
#endif
      }
  for (unsigned length = 0; length <= MAX_LENGTH; ++length)
    for (unsigned at = 0; at < MAX_OFFSET; ++at) {
      pattern(source, 6);
      pattern(destination, 6);
      if (compare_bytes(source + at, destination + at, length) != 0) return 8;
#ifndef __APPLE__
      if (equal_bytes(source + at, destination + at, length) != 0) return 9;
#endif
      for (unsigned position = 0; position < length; ++position) {
        pattern(source, 6);
        pattern(destination, 6);
        /* The first unequal byte decides the order even when every later byte disagrees. */
        ((volatile unsigned char *)source)[at + position] = 10;
        ((volatile unsigned char *)destination)[at + position] = 200;
        for (unsigned i = position + 1; i < length; ++i) {
          ((volatile unsigned char *)source)[at + i] = 255;
          ((volatile unsigned char *)destination)[at + i] = 0;
        }
        if (sign(compare_bytes(source + at, destination + at, length)) != -1) return 10;
        if (sign(compare_bytes(destination + at, source + at, length)) != 1) return 11;
#ifndef __APPLE__
        if (equal_bytes(source + at, destination + at, length) == 0) return 12;
#endif
      }
    }
  return 42;
}
