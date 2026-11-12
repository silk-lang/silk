// The C baselines of the inflate benchmark: system zlib, zlib-ng and libdeflate on the same pack
// the Silk program reads, with the same modes and the same output lines.
//
//   baseline <zlib|zlib-ng|libdeflate> <chunk|whole|crc> <rounds> <pack>
//
// The pack is "SILKGZ1\0", a u32 count, then per entry a u32 name length, the name, the u64
// compressed and decompressed lengths and the gzip bytes, all little-endian. Each mode prints
// one line per entry: name, compressed bytes, output bytes, the fastest round in nanoseconds
// and the CRC-32 of the output in decimal.
//
// `chunk` decodes into a 64 KiB buffer that it reuses, `whole` into one buffer that holds the
// output, and `crc` only checksums the decoded bytes. libdeflate has no streaming decoder, so it
// has no `chunk` mode.
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(USE_ZLIB_NG)
#include <zlib-ng.h>
#define Z(name) zng_##name
#define Z_STREAM zng_stream
#else
#include <zlib.h>
#define Z(name) name
#define Z_STREAM z_stream
#endif
#include <libdeflate.h>

#define CHUNK 65536

typedef struct {
  const char *name;
  uint32_t name_length;
  const uint8_t *gzip;
  uint64_t gzip_length;
  uint64_t raw_length;
  uint64_t best;
  uint32_t crc;
} Entry;

static uint64_t now(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000000000u + (uint64_t)time.tv_nsec;
}

static void fail(const char *message, const Entry *entry) {
  fprintf(stderr, "baseline: %s: %.*s\n", message, entry ? (int)entry->name_length : 0, entry ? entry->name : "");
  exit(1);
}

static uint64_t read64(const uint8_t *at) {
  uint64_t value;
  memcpy(&value, at, 8);
  return value;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: baseline <zlib|zlib-ng|libdeflate> <chunk|whole|crc> <rounds> <pack>\n");
    return 2;
  }
  const int deflate = strcmp(argv[1], "libdeflate") == 0;
  const char *mode = argv[2];
  const int rounds = atoi(argv[3]);
  FILE *file = fopen(argv[4], "rb");
  if (!file) fail("cannot open the pack", NULL);
  fseek(file, 0, SEEK_END);
  const long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  uint8_t *pack = malloc((size_t)size);
  if (!pack || fread(pack, 1, (size_t)size, file) != (size_t)size) fail("cannot read the pack", NULL);
  fclose(file);
  if (memcmp(pack, "SILKGZ1", 8) != 0) fail("not a pack", NULL);
  uint32_t count;
  memcpy(&count, pack + 8, 4);
  Entry *entries = calloc(count, sizeof(Entry));
  const uint8_t *at = pack + 12;
  uint64_t largest = 0;
  for (uint32_t index = 0; index < count; index++) {
    Entry *entry = &entries[index];
    memcpy(&entry->name_length, at, 4);
    entry->name = (const char *)at + 4;
    at += 4 + entry->name_length;
    entry->gzip_length = read64(at);
    entry->raw_length = read64(at + 8);
    entry->gzip = at + 16;
    at += 16 + entry->gzip_length;
    entry->best = UINT64_MAX;
    if (entry->raw_length > largest) largest = entry->raw_length;
  }
  const int checksum = strcmp(mode, "crc") == 0;
  struct libdeflate_decompressor *decompressor = libdeflate_alloc_decompressor();
  uint8_t *output = malloc(largest + 1);
  // The `crc` mode decodes every entry once, before the rounds, so a round is only checksums.
  uint8_t **decoded = calloc(count, sizeof(uint8_t *));
  for (uint32_t index = 0; checksum && index < count; index++) {
    const Entry *entry = &entries[index];
    size_t written = 0;
    decoded[index] = malloc(entry->raw_length + 1);
    if (libdeflate_gzip_decompress(decompressor, entry->gzip, entry->gzip_length, decoded[index],
                                   entry->raw_length, &written) != LIBDEFLATE_SUCCESS) fail("decode", entry);
  }
  uint8_t *chunk = malloc(CHUNK);
  Z_STREAM stream;
  memset(&stream, 0, sizeof stream);
  if (Z(inflateInit2)(&stream, 15 + 16) != Z_OK) fail("inflateInit2", NULL);

  for (int round = 0; round < rounds; round++) {
    for (uint32_t index = 0; index < count; index++) {
      Entry *entry = &entries[index];
      uint64_t elapsed;
      uint32_t crc = 0;
      if (checksum) {
        const uint64_t start = now();
        crc = deflate ? libdeflate_crc32(0, decoded[index], entry->raw_length)
                      : (uint32_t)Z(crc32)(0, decoded[index], (uint32_t)entry->raw_length);
        elapsed = now() - start;
      } else if (deflate) {
        if (strcmp(mode, "whole") != 0) fail("libdeflate has only the whole mode", NULL);
        size_t written = 0;
        const uint64_t start = now();
        const enum libdeflate_result result =
          libdeflate_gzip_decompress(decompressor, entry->gzip, entry->gzip_length, output, largest, &written);
        elapsed = now() - start;
        if (result != LIBDEFLATE_SUCCESS || written != entry->raw_length) fail("decode", entry);
        crc = libdeflate_crc32(0, output, written);
      } else {
        const int whole = strcmp(mode, "whole") == 0;
        uint64_t written = 0;
        const uint64_t start = now();
        Z(inflateReset)(&stream);
        stream.next_in = (void *)entry->gzip;
        stream.avail_in = (uint32_t)entry->gzip_length;
        int result = Z_OK;
        while (result == Z_OK) {
          stream.next_out = whole ? output + written : chunk;
          stream.avail_out = whole ? (uint32_t)(largest - written) : CHUNK;
          const uint32_t room = stream.avail_out;
          result = Z(inflate)(&stream, Z_NO_FLUSH);
          written += room - stream.avail_out;
        }
        elapsed = now() - start;
        if (result != Z_STREAM_END || written != entry->raw_length) fail("decode", entry);
        // The gzip trailer the decoder verified holds the CRC-32 of the output.
        memcpy(&crc, entry->gzip + entry->gzip_length - 8, 4);
      }
      if (elapsed < entry->best) entry->best = elapsed;
      entry->crc = crc;
    }
  }
  for (uint32_t index = 0; index < count; index++) {
    const Entry *entry = &entries[index];
    printf("%.*s\t%llu\t%llu\t%llu\t%u\n", (int)entry->name_length, entry->name,
           (unsigned long long)entry->gzip_length, (unsigned long long)entry->raw_length,
           (unsigned long long)entry->best, entry->crc);
  }
  return 0;
}
