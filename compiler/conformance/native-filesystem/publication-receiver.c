#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern int publication_fixture(int selector, int policy, int durability);
enum { CREATE, ATOMIC, SYNC_DIRECTORY, ORDINARY_WRITE };
enum { REPLACE, CREATE_NEW };
enum { BUFFERED, SYNCHRONIZED };
enum { FAIL_STAGE = 1, FAIL_WRITE = 2, FAIL_FILE_SYNC = 4, FAIL_DIRECTORY_SYNC = 8,
       FAIL_CLEANUP = 16, FAIL_CLOSE = 32, COLLIDE = 64, SHORT_WRITES = 128 };
enum { ALREADY_EXISTS = 1, INVALID_PATH = 3, WRONG_TYPE = 4 };
struct reported_error {
  int published, operation, reason, native_code, cleanup_operation, cleanup_reason, cleanup_native;
  size_t staging_length;
  char staging[NAME_MAX + 1];
};
static struct reported_error reported;
static const char *case_name;
static char sandbox[PATH_MAX], root[PATH_MAX], outside[PATH_MAX];
static const unsigned char *inputs[3];
static size_t input_lengths[3];
static int armed, selector, faults, stage_fd, stage_closed, stage_close_calls;
static int sequence, last_write, file_sync, publication, cleanup, directory_sync, file_sync_calls, directory_sync_calls;
static int stage_open_calls, write_calls, cleanup_calls, hook_invalid;
static struct stat staged_inode, parent_inode;
static char stage_name[NAME_MAX + 1];
static int collision_request = -1, collision_reply = -1;
static int (*os_openat)(int, const char *, int, ...);
static ssize_t (*os_write)(int, const void *, size_t);
static int (*os_fsync)(int), (*os_close)(int);
static int (*os_renameat)(int, const char *, int, const char *);
static int (*os_linkat)(int, const char *, int, const char *, int);
static int (*os_unlinkat)(int, const char *, int);

static void die(const char *condition, int line) {
  fprintf(stderr,
    "publication case=%s line=%d assertion=%s errno=%d\n"
    "  published=%d operation=%d reason=%d native=%d cleanup=(%d,%d,%d) residual=%.*s\n"
    "  stage=%s open=%d writes=%d closes=%d syncs=(%d,%d) cleanup=%d invalid=%d order=(write:%d file:%d publish:%d cleanup:%d directory:%d)\n",
    case_name, line, condition, errno, reported.published, reported.operation, reported.reason,
    reported.native_code, reported.cleanup_operation, reported.cleanup_reason, reported.cleanup_native,
    (int)reported.staging_length, reported.staging, stage_name, stage_open_calls, write_calls,
    stage_close_calls, file_sync_calls, directory_sync_calls, cleanup_calls, hook_invalid,
    last_write, file_sync, publication, cleanup, directory_sync);
  exit(1);
}
#define CHECK(condition) do { if (!(condition)) die(#condition, __LINE__); } while (0)
#define LOAD(name) do { *(void **)(&os_##name) = dlsym(RTLD_NEXT, #name); CHECK(os_##name != NULL); } while (0)
static int same_inode(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
static void full_write(int fd, const void *bytes, size_t count) {
  const unsigned char *at = bytes;
  while (count) {
    ssize_t wrote = os_write(fd, at, count);
    if (wrote < 0 && errno == EINTR) continue;
    CHECK(wrote > 0); at += wrote; count -= (size_t)wrote;
  }
}
static void full_read(int fd, void *bytes, size_t count) {
  unsigned char *at = bytes;
  while (count) {
    ssize_t got = read(fd, at, count);
    if (got < 0 && errno == EINTR) continue;
    CHECK(got > 0); at += got; count -= (size_t)got;
  }
}

// These wrappers inject only syscall failures/short transfers. Every successful mutation is a
// real OS operation. They are linked into the independent C consumer, never into the provider.
int openat(int parent, const char *name, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list args; va_start(args, flags);
#ifdef __APPLE__
    mode = (mode_t)va_arg(args, int);
#else
    mode = va_arg(args, unsigned int);
#endif
    va_end(args);
  }
  int staging = armed && selector == ATOMIC && (flags & O_CREAT);
  if (staging) {
    ++stage_open_calls;
    if (!(flags & O_EXCL) || !(flags & O_NOFOLLOW) || !(flags & O_CLOEXEC) ||
        (flags & O_TRUNC) || strchr(name, '/') || mode != 0666) hook_invalid = 1;
    CHECK(strlen(name) <= NAME_MAX);
    strcpy(stage_name, name);
    CHECK(fstat(parent, &parent_inode) == 0 && S_ISDIR(parent_inode.st_mode));
    if (faults & FAIL_STAGE) { errno = ENOSPC; return -1; }
  }
  int fd = os_openat(parent, name, flags, mode);
  // The provider may reuse a closed staging descriptor's number, such as to reopen the parent for fsync.
  if (!staging && fd >= 0 && fd == stage_fd && stage_closed) stage_fd = -1;
  if (staging && fd >= 0) {
    stage_fd = fd;
    CHECK(fstat(fd, &staged_inode) == 0 && S_ISREG(staged_inode.st_mode));
  }
  return fd;
}
ssize_t write(int fd, const void *bytes, size_t count) {
  if (!armed || (selector != CREATE && fd != stage_fd)) return os_write(fd, bytes, count);
  ++write_calls;
  last_write = ++sequence;
  if (faults & FAIL_WRITE) {
    if (write_calls > 1) { errno = EIO; return -1; }
    if (count > 7) count = 7;
  }
  if ((faults & SHORT_WRITES) && count > 4096) count = 4096;
  return os_write(fd, bytes, count);
}
int fsync(int fd) {
  if (!armed) return os_fsync(fd);
  struct stat info;
  CHECK(fstat(fd, &info) == 0);
  if (S_ISDIR(info.st_mode)) {
    ++directory_sync_calls; directory_sync = ++sequence;
    if (selector == ATOMIC && (!same_inode(&info, &parent_inode) || !publication)) hook_invalid = 1;
    if (faults & FAIL_DIRECTORY_SYNC) { errno = EIO; return -1; }
  } else {
    ++file_sync_calls; file_sync = ++sequence;
    if (fd != stage_fd || !same_inode(&info, &staged_inode) || stage_closed || publication) hook_invalid = 1;
    if (faults & FAIL_FILE_SYNC) { errno = EIO; return -1; }
  }
  return os_fsync(fd);
}
int close(int fd) {
  if (armed && fd == stage_fd && !stage_closed) {
    ++stage_close_calls;
    int result = os_close(fd);
    stage_closed = 1;
    if (faults & FAIL_CLOSE) { errno = EINTR; return -1; }
    return result;
  }
  // A retry after an injected EINTR must not accidentally close a reused descriptor.
  if (armed && fd == stage_fd && stage_closed) { ++stage_close_calls; hook_invalid = 1; }
  return os_close(fd);
}
static void before_publication(int old_parent, const char *old_name, int new_parent) {
  struct stat before, after;
  CHECK(fstat(old_parent, &before) == 0 && fstat(new_parent, &after) == 0);
  if (!same_inode(&before, &parent_inode) || !same_inode(&after, &parent_inode) ||
      strcmp(old_name, stage_name) || !stage_closed) hook_invalid = 1;
  if (faults & COLLIDE) {
    const char token = 'C'; char done;
    full_write(collision_request, &token, 1);
    full_read(collision_reply, &done, 1);
    CHECK(done == 'D');
  }
}
int renameat(int old_parent, const char *old_name, int new_parent, const char *new_name) {
  if (armed) before_publication(old_parent, old_name, new_parent);
  int result = os_renameat(old_parent, old_name, new_parent, new_name);
  if (armed && result == 0) publication = ++sequence;
  return result;
}
int linkat(int old_parent, const char *old_name, int new_parent, const char *new_name, int flags) {
  if (armed) { before_publication(old_parent, old_name, new_parent); if (flags != 0) hook_invalid = 1; }
  int result = os_linkat(old_parent, old_name, new_parent, new_name, flags);
  if (armed && result == 0) publication = ++sequence;
  return result;
}
int unlinkat(int parent, const char *name, int flags) {
  if (armed && selector == ATOMIC) {
    struct stat info;
    CHECK(fstat(parent, &info) == 0);
    if (!same_inode(&info, &parent_inode) || strcmp(name, stage_name) || flags != 0) hook_invalid = 1;
    ++cleanup_calls; cleanup = ++sequence;
    if (faults & FAIL_CLEANUP) { errno = EACCES; return -1; }
  }
  return os_unlinkat(parent, name, flags);
}

size_t publication_input_length(int which) { CHECK(which >= 0 && which < 3); return input_lengths[which]; }
unsigned char publication_input_byte(int which, size_t index) {
  CHECK(which >= 0 && which < 3 && index < input_lengths[which]); return inputs[which][index];
}
void publication_error(int published, int operation, int reason, int native_code,
                       int cleanup_operation, int cleanup_reason, int cleanup_native, size_t length) {
  CHECK(length <= NAME_MAX);
  reported.published = published; reported.operation = operation; reported.reason = reason;
  reported.native_code = native_code; reported.cleanup_operation = cleanup_operation;
  reported.cleanup_reason = cleanup_reason; reported.cleanup_native = cleanup_native;
  reported.staging_length = length; reported.staging[length] = 0;
}
void publication_staging_byte(size_t index, unsigned char value) {
  CHECK(index < NAME_MAX); reported.staging[index] = (char)value;
}
static int invoke(int operation, const char *name, const void *bytes, size_t length, int policy, int durability, int failures) {
  memset(&reported, 0, sizeof(reported));
  reported.operation = reported.reason = reported.native_code = -1;
  reported.cleanup_operation = reported.cleanup_reason = reported.cleanup_native = -1;
  stage_fd = -1; stage_closed = stage_close_calls = stage_open_calls = write_calls = cleanup_calls = hook_invalid = 0;
  sequence = last_write = file_sync = publication = cleanup = directory_sync = file_sync_calls = directory_sync_calls = 0;
  stage_name[0] = 0; selector = operation; faults = failures;
  inputs[0] = (const unsigned char *)root; input_lengths[0] = strlen(root);
  inputs[1] = (const unsigned char *)name; input_lengths[1] = strlen(name);
  inputs[2] = bytes; input_lengths[2] = length;
  armed = 1;
  int result = publication_fixture(operation, policy, durability);
  armed = 0;
  CHECK(!hook_invalid);
  return result;
}
static void path_at(char *path, const char *base, const char *name) {
  CHECK(snprintf(path, PATH_MAX, "%s/%s", base, name) < PATH_MAX);
}
static void put(const char *name, const void *bytes, size_t length, mode_t mode) {
  char path[PATH_MAX]; path_at(path, root, name);
  int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW, mode);
  CHECK(fd >= 0); full_write(fd, bytes, length); CHECK(os_close(fd) == 0);
}
static void contents_at(const char *base, const char *name, const void *bytes, size_t length) {
  char path[PATH_MAX]; path_at(path, base, name);
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  CHECK(fd >= 0);
  unsigned char buffer[4096]; const unsigned char *expected = bytes; size_t offset = 0;
  for (;;) {
    ssize_t got = read(fd, buffer, sizeof(buffer));
    if (got < 0 && errno == EINTR) continue;
    CHECK(got >= 0);
    if (got == 0) break;
    CHECK((size_t)got <= length - offset && memcmp(buffer, expected + offset, (size_t)got) == 0);
    offset += (size_t)got;
  }
  CHECK(offset == length && os_close(fd) == 0);
}
static void contents(const char *name, const void *bytes, size_t length) { contents_at(root, name, bytes, length); }
static void absent(const char *name) {
  char path[PATH_MAX]; struct stat info; path_at(path, root, name);
  CHECK(lstat(path, &info) == -1 && errno == ENOENT);
}
static int staging_count(void) {
  DIR *directory = opendir(root); CHECK(directory != NULL); int count = 0; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) if (strncmp(entry->d_name, ".silk-stage-", 12) == 0) ++count;
  CHECK(closedir(directory) == 0); return count;
}
static void remove_name(const char *name) {
  char path[PATH_MAX]; path_at(path, root, name); CHECK(unlink(path) == 0);
}
static void child_ok(pid_t child) {
  int status; CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static const char old_bytes[] = "old-complete-payload";
static const char new_bytes[] = "new-complete-payload-with-a-different-length";
#define OLD old_bytes, (sizeof(old_bytes) - 1)
#define NEW new_bytes, (sizeof(new_bytes) - 1)

static void existing_names(void) {
  case_name = "exclusive-existing-file-directory-symlink";
  put("file", OLD, 0600);
  CHECK(invoke(CREATE, "/file", NEW, REPLACE, BUFFERED, 0) == 1);
  CHECK(reported.operation == 9 && reported.reason == ALREADY_EXISTS && reported.native_code == EEXIST);
  contents("file", OLD);
  char directory[PATH_MAX], symlink_path[PATH_MAX], target[PATH_MAX];
  path_at(directory, root, "directory"); CHECK(mkdir(directory, 0700) == 0);
  CHECK(invoke(CREATE, "/directory", NEW, REPLACE, BUFFERED, 0) == 1 && reported.reason == ALREADY_EXISTS);
  struct stat info; CHECK(lstat(directory, &info) == 0 && S_ISDIR(info.st_mode));
  path_at(symlink_path, root, "symlink"); path_at(target, outside, "sentinel");
  CHECK(symlink(target, symlink_path) == 0);
  CHECK(invoke(CREATE, "/symlink", NEW, REPLACE, BUFFERED, 0) == 1 && reported.reason == ALREADY_EXISTS);
  CHECK(lstat(symlink_path, &info) == 0 && S_ISLNK(info.st_mode));
  contents_at(outside, "sentinel", OLD);
  CHECK(invoke(ATOMIC, "/symlink", NEW, CREATE_NEW, BUFFERED, 0) == 1);
  CHECK(reported.reason == ALREADY_EXISTS && reported.published == 0 && reported.staging_length == 0);
  CHECK(lstat(symlink_path, &info) == 0 && S_ISLNK(info.st_mode));
  CHECK(invoke(ATOMIC, "/directory", NEW, CREATE_NEW, BUFFERED, 0) == 1 && reported.reason == ALREADY_EXISTS);
  CHECK(invoke(ATOMIC, "/file", NEW, CREATE_NEW, BUFFERED, 0) == 1 && reported.reason == ALREADY_EXISTS);
  contents("file", OLD); CHECK(staging_count() == 0);
}

static void concurrent_claims(void) {
  case_name = "two-independent-process-exclusive-claims";
  int start[2], results[2]; CHECK(pipe(start) == 0 && pipe(results) == 0);
  pid_t children[2];
  for (int index = 0; index < 2; ++index) {
    children[index] = fork(); CHECK(children[index] >= 0);
    if (children[index] == 0) {
      char token; full_read(start[0], &token, 1);
      const char *payload = index == 0 ? old_bytes : new_bytes;
      int result = invoke(CREATE, "/claim", payload, strlen(payload), REPLACE, BUFFERED, 0);
      int receipt[4] = { index, result, reported.reason, reported.native_code };
      full_write(results[1], receipt, sizeof(receipt)); _exit(0);
    }
  }
  full_write(start[1], "GO", 2);
  int winner = -1;
  for (int index = 0; index < 2; ++index) {
    int receipt[4]; full_read(results[0], receipt, sizeof(receipt));
    if (receipt[1] == 0) { CHECK(winner == -1); winner = receipt[0]; }
    else CHECK(receipt[1] == 1 && receipt[2] == ALREADY_EXISTS && receipt[3] == EEXIST);
  }
  CHECK(winner != -1); child_ok(children[0]); child_ok(children[1]);
  if (winner == 0) contents("claim", OLD); else contents("claim", NEW);
  CHECK(os_close(start[0]) == 0 && os_close(start[1]) == 0 && os_close(results[0]) == 0 && os_close(results[1]) == 0);
}

static void controlled_collision(void) {
  case_name = "create-new-collision-at-publication";
  int request[2], reply[2]; CHECK(pipe(request) == 0 && pipe(reply) == 0);
  pid_t child = fork(); CHECK(child >= 0);
  if (child == 0) {
    char token; full_read(request[0], &token, 1);
    CHECK(invoke(CREATE, "/collision", OLD, REPLACE, BUFFERED, 0) == 0);
    full_write(reply[1], "D", 1); _exit(0);
  }
  collision_request = request[1]; collision_reply = reply[0];
  CHECK(invoke(ATOMIC, "/collision", NEW, CREATE_NEW, SYNCHRONIZED, COLLIDE) == 1);
  CHECK(reported.published == 0 && reported.reason == ALREADY_EXISTS && reported.native_code == EEXIST);
  CHECK(file_sync_calls == 1 && directory_sync_calls == 0 && cleanup_calls == 1 && reported.staging_length == 0);
  contents("collision", OLD); CHECK(staging_count() == 0); child_ok(child);
  for (int index = 0; index < 2; ++index) { CHECK(os_close(request[index]) == 0 && os_close(reply[index]) == 0); }
  collision_request = collision_reply = -1;
}

static void staging_collision(void) {
  case_name = "exclusive-staging-refuses-preexisting-symlink";
  const char *occupied = ".silk-stage-0000000000000000";
  char path[PATH_MAX], target[PATH_MAX]; struct stat info;
  path_at(path, root, occupied); path_at(target, outside, "sentinel");
  CHECK(symlink(target, path) == 0);
  CHECK(invoke(ATOMIC, "/stage-collision", NEW, REPLACE, BUFFERED, 0) == 0);
  CHECK(stage_open_calls >= 2 && lstat(path, &info) == 0 && S_ISLNK(info.st_mode));
  contents("stage-collision", NEW); contents_at(outside, "sentinel", OLD);
  CHECK(staging_count() == 1); remove_name(occupied);
}

static void before_publication_failures(void) {
  const int failures[] = { FAIL_STAGE, FAIL_WRITE, FAIL_FILE_SYNC, FAIL_CLOSE };
  const int native_codes[] = { ENOSPC, EIO, EIO, EINTR };
  const int operations[] = { 10, 10, 11, 10 };
  const char *names[] = { "stage-open-failure", "partial-write-failure", "file-sync-failure", "close-EINTR-not-retried" };
  for (size_t index = 0; index < sizeof(failures) / sizeof(failures[0]); ++index) {
    case_name = names[index]; put("failure", OLD, 0600);
    CHECK(invoke(ATOMIC, "/failure", NEW, REPLACE, SYNCHRONIZED, failures[index]) == 1);
    CHECK(reported.published == 0 && reported.operation == operations[index] && reported.native_code == native_codes[index]);
    CHECK(reported.cleanup_operation == -1 && reported.staging_length == 0 && publication == 0 && directory_sync_calls == 0);
    contents("failure", OLD); CHECK(staging_count() == 0);
    CHECK(invoke(ATOMIC, "/absent-failure", NEW, CREATE_NEW, SYNCHRONIZED, failures[index]) == 1);
    CHECK(reported.published == 0 && reported.native_code == native_codes[index]);
    absent("absent-failure"); CHECK(staging_count() == 0);
    if (failures[index] == FAIL_CLOSE) CHECK(stage_close_calls == 1);
  }
  case_name = "primary-write-and-cleanup-errors-independent";
  CHECK(invoke(ATOMIC, "/failure", NEW, REPLACE, SYNCHRONIZED, FAIL_WRITE | FAIL_CLEANUP) == 1);
  CHECK(reported.published == 0 && reported.native_code == EIO && reported.cleanup_native == EACCES);
  CHECK(reported.cleanup_operation >= 0 && reported.staging_length > 0 && strcmp(reported.staging, stage_name) == 0);
  CHECK(strchr(reported.staging, '/') == NULL && staging_count() == 1);
  contents("failure", OLD); contents(reported.staging, new_bytes, 7);
  contents_at(outside, "sentinel", OLD); remove_name(reported.staging);

  case_name = "direct-exclusive-write-failure-keeps-claimed-prefix";
  CHECK(invoke(CREATE, "/partial-claim", NEW, REPLACE, BUFFERED, FAIL_WRITE) == 1);
  CHECK(reported.operation == 9 && reported.native_code == EIO);
  contents("partial-claim", new_bytes, 7);
}

static void after_publication_failures(void) {
  case_name = "published-directory-sync-failure"; put("published", OLD, 0600);
  CHECK(invoke(ATOMIC, "/published", NEW, REPLACE, SYNCHRONIZED, FAIL_DIRECTORY_SYNC) == 1);
  CHECK(reported.published == 1 && reported.operation == 12 && reported.native_code == EIO);
  CHECK(reported.cleanup_operation == -1 && reported.staging_length == 0 && file_sync < publication && publication < directory_sync);
  contents("published", NEW); CHECK(staging_count() == 0);

  case_name = "published-create-new-cleanup-failure";
  CHECK(invoke(ATOMIC, "/published-link", NEW, CREATE_NEW, SYNCHRONIZED, FAIL_CLEANUP) == 1);
  CHECK(reported.published == 1 && reported.native_code == EACCES && reported.cleanup_native == EACCES);
  CHECK(reported.staging_length > 0 && strcmp(reported.staging, stage_name) == 0 && staging_count() == 1);
  contents("published-link", NEW); contents(reported.staging, NEW);
  char path[PATH_MAX]; struct stat destination, residual;
  path_at(path, root, "published-link"); CHECK(lstat(path, &destination) == 0);
  path_at(path, root, reported.staging); CHECK(lstat(path, &residual) == 0 && same_inode(&destination, &residual));
  remove_name(reported.staging); contents("published-link", NEW);
  contents_at(outside, "sentinel", OLD);
}

static void confinement_and_kinds(void) {
  case_name = "confinement-and-wrong-entry-kinds";
  char path[PATH_MAX]; path_at(path, root, "escape"); CHECK(symlink(outside, path) == 0);
  for (int operation = CREATE; operation <= SYNC_DIRECTORY; ++operation) {
    const char *name = operation == SYNC_DIRECTORY ? "/escape" : "/escape/sentinel";
    CHECK(invoke(operation, name, NEW, REPLACE, SYNCHRONIZED, 0) == 1);
    CHECK(reported.published == 0 && publication == 0 && stage_open_calls == 0);
    contents_at(outside, "sentinel", OLD); CHECK(staging_count() == 0);
  }
  CHECK(invoke(ATOMIC, "/../outside/sentinel", NEW, REPLACE, BUFFERED, 0) == 1 && reported.reason == INVALID_PATH);
  CHECK(invoke(ATOMIC, "/directory", NEW, REPLACE, BUFFERED, 0) == 1 && reported.reason == WRONG_TYPE && !reported.published);
  path_at(path, root, "fifo"); CHECK(mkfifo(path, 0600) == 0);
  CHECK(invoke(ATOMIC, "/fifo", NEW, REPLACE, BUFFERED, 0) == 1 && reported.reason == WRONG_TYPE);
  struct stat info; CHECK(lstat(path, &info) == 0 && S_ISFIFO(info.st_mode));
  CHECK(invoke(SYNC_DIRECTORY, "/file", "", 0, REPLACE, BUFFERED, 0) == 1);
  CHECK(directory_sync_calls == 0);
  CHECK(invoke(ATOMIC, "/symlink", NEW, REPLACE, BUFFERED, 0) == 0);
  contents("symlink", NEW); contents_at(outside, "sentinel", OLD);
#ifdef __APPLE__
  // APFS rejects malformed UTF-8 at the OS boundary. Preserve that native failure, then exercise
  // an accepted multibyte name; GNU/Linux additionally admits arbitrary non-UTF-8 name bytes.
  const char invalid_name[] = { '/', (char)0xff, 'x', 0 };
  CHECK(invoke(CREATE, invalid_name, OLD, REPLACE, BUFFERED, 0) == 1 && reported.native_code == EILSEQ);
  const char raw_name[] = { '/', (char)0xc3, (char)0xa9, 'x', 0 };
#else
  const char raw_name[] = { '/', (char)0xff, 'x', 0 };
#endif
  CHECK(invoke(CREATE, raw_name, OLD, REPLACE, BUFFERED, 0) == 0);
  CHECK(invoke(ATOMIC, raw_name, NEW, REPLACE, BUFFERED, 0) == 0);
  contents(raw_name + 1, NEW); CHECK(staging_count() == 0);
}

static void modes_and_synchronization(void) {
  case_name = "fresh-inode-mode-and-hardlink-contract";
  mode_t old_umask = umask(0027);
  CHECK(invoke(CREATE, "/mode-create", NEW, REPLACE, BUFFERED, 0) == 0);
  char path[PATH_MAX], alias[PATH_MAX]; struct stat info, old_inode;
  path_at(path, root, "mode-create"); CHECK(lstat(path, &info) == 0 && (info.st_mode & 07777) == 0640);
  put("mode-replace", OLD, 0600); path_at(path, root, "mode-replace"); path_at(alias, root, "old-hardlink");
  CHECK(chmod(path, 0600) == 0 && link(path, alias) == 0 && lstat(path, &old_inode) == 0);
  CHECK(invoke(ATOMIC, "/mode-replace", NEW, REPLACE, SYNCHRONIZED, 0) == 0);
  CHECK(file_sync_calls == 1 && directory_sync_calls == 1 && last_write < file_sync && file_sync < publication && publication < directory_sync);
  CHECK(lstat(path, &info) == 0 && !same_inode(&info, &old_inode) && (info.st_mode & 07777) == 0640);
  contents("old-hardlink", OLD); contents("mode-replace", NEW);
  CHECK(invoke(ATOMIC, "/mode-new", NEW, CREATE_NEW, SYNCHRONIZED, 0) == 0);
  CHECK(file_sync_calls == 1 && directory_sync_calls == 1 && last_write < file_sync && file_sync < publication && publication < cleanup && cleanup < directory_sync);
  path_at(path, root, "mode-new"); CHECK(lstat(path, &info) == 0 && (info.st_mode & 07777) == 0640);
  CHECK(invoke(ATOMIC, "/mode-new", OLD, REPLACE, BUFFERED, 0) == 0);
  CHECK(file_sync_calls == 0 && directory_sync_calls == 0);
  CHECK(invoke(SYNC_DIRECTORY, "/", "", 0, REPLACE, BUFFERED, 0) == 0 && directory_sync_calls == 1);
  CHECK(invoke(SYNC_DIRECTORY, "/", "", 0, REPLACE, BUFFERED, FAIL_DIRECTORY_SYNC) == 1);
  CHECK(reported.operation == 12 && reported.native_code == EIO && directory_sync_calls == 1);
  // Ordinary write still truncates in place, retaining the inode, hard link, and permission bits.
  CHECK(invoke(ORDINARY_WRITE, "/old-hardlink", "x", 1, REPLACE, BUFFERED, 0) == 0);
  path_at(path, root, "old-hardlink"); CHECK(lstat(path, &info) == 0 && same_inode(&info, &old_inode) && (info.st_mode & 07777) == 0600);
  contents("old-hardlink", "x", 1); CHECK(file_sync_calls == 0 && directory_sync_calls == 0);
  umask(old_umask);
}

// Homebrew's Linux sandbox and 0711 homes leave ancestors searchable but unreadable. Path walks
// must only need search permission; fsync still reopens the leaf directory itself. A privileged
// run bypasses the mode, so this only discriminates for an ordinary user.
static void search_only_ancestor(void) {
  case_name = "search-only-ancestor";
  char opaque[PATH_MAX], inner[PATH_MAX], file[PATH_MAX];
  path_at(opaque, root, "opaque"); path_at(inner, opaque, "inner"); path_at(file, inner, "search-only");
  CHECK(mkdir(opaque, 0700) == 0 && mkdir(inner, 0700) == 0 && chmod(opaque, 0311) == 0);
  CHECK(invoke(CREATE, "/opaque/inner/search-only", OLD, REPLACE, BUFFERED, 0) == 0);
  CHECK(invoke(ATOMIC, "/opaque/inner/search-only", NEW, REPLACE, SYNCHRONIZED, 0) == 0 && directory_sync_calls == 1);
  CHECK(invoke(SYNC_DIRECTORY, "/opaque/inner", "", 0, REPLACE, BUFFERED, 0) == 0 && directory_sync_calls == 1);
  CHECK(chmod(opaque, 0700) == 0);
  contents_at(inner, "search-only", NEW);
  CHECK(unlink(file) == 0 && rmdir(inner) == 0 && rmdir(opaque) == 0);
}

struct observations { _Atomic unsigned old, newer, stopped, invalid; };
static void complete_publication(void) {
  case_name = "real-readers-see-only-complete-old-or-new";
  enum { LENGTH = 32768, REPLACEMENTS = 128 };
  unsigned char before[LENGTH], after[LENGTH]; memset(before, 'A', sizeof(before)); memset(after, 'B', sizeof(after));
  put("observed", before, sizeof(before), 0600);
  struct observations *seen = mmap(NULL, sizeof(*seen), PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  CHECK(seen != MAP_FAILED); memset(seen, 0, sizeof(*seen));
  char path[PATH_MAX]; path_at(path, root, "observed");
  pid_t reader = fork(); CHECK(reader >= 0);
  if (reader == 0) {
    unsigned char buffer[LENGTH + 1];
    while (!atomic_load(&seen->stopped)) {
      int fd = open(path, O_RDONLY | O_NOFOLLOW);
      if (fd < 0) { atomic_store(&seen->invalid, 1); _exit(1); }
      size_t used = 0;
      while (used < sizeof(buffer)) {
        ssize_t got = read(fd, buffer + used, sizeof(buffer) - used);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) { atomic_store(&seen->invalid, 2); _exit(1); }
        if (got == 0) break;
        used += (size_t)got;
      }
      if (os_close(fd) != 0 || used != LENGTH) { atomic_store(&seen->invalid, 3); _exit(1); }
      if (memcmp(buffer, before, LENGTH) == 0) atomic_fetch_add(&seen->old, 1);
      else if (memcmp(buffer, after, LENGTH) == 0) atomic_fetch_add(&seen->newer, 1);
      else { atomic_store(&seen->invalid, 4); _exit(1); }
    }
    _exit(0);
  }
  while (!atomic_load(&seen->old)) { CHECK(!atomic_load(&seen->invalid)); sched_yield(); }
  for (int index = 0; index < REPLACEMENTS; ++index) {
    const unsigned char *payload = index % 2 == 0 ? after : before;
    CHECK(invoke(ATOMIC, "/observed", payload, LENGTH, REPLACE, BUFFERED, SHORT_WRITES) == 0);
    CHECK(!atomic_load(&seen->invalid) && write_calls > 1);
    if (index == 0) while (!atomic_load(&seen->newer)) { CHECK(!atomic_load(&seen->invalid)); sched_yield(); }
  }
  atomic_store(&seen->stopped, 1); child_ok(reader);
  CHECK(atomic_load(&seen->old) > 0 && atomic_load(&seen->newer) > 0 && !atomic_load(&seen->invalid));
  printf("native publication: %u complete old + %u complete new reader observations across %d replacements\n",
         atomic_load(&seen->old), atomic_load(&seen->newer), REPLACEMENTS);
  CHECK(munmap(seen, sizeof(*seen)) == 0 && staging_count() == 0);
}

static void cleanup_tree(const char *base) {
  DIR *directory = opendir(base); CHECK(directory != NULL); struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    char path[PATH_MAX]; struct stat info; path_at(path, base, entry->d_name); CHECK(lstat(path, &info) == 0);
    if (S_ISDIR(info.st_mode)) cleanup_tree(path); else CHECK(unlink(path) == 0);
  }
  CHECK(closedir(directory) == 0 && rmdir(base) == 0);
}
int main(void) {
  case_name = "setup";
  LOAD(openat); LOAD(write); LOAD(fsync); LOAD(close); LOAD(renameat); LOAD(linkat); LOAD(unlinkat);
  // A watchdog bounds deadlocks in the concurrent protocols; it is not a performance assertion.
  alarm(90);
#ifdef __APPLE__
  strcpy(sandbox, "/private/tmp/silk-publication-XXXXXX");
#else
  strcpy(sandbox, "/tmp/silk-publication-XXXXXX");
#endif
  CHECK(mkdtemp(sandbox) != NULL); path_at(root, sandbox, "root"); path_at(outside, sandbox, "outside");
  CHECK(mkdir(root, 0700) == 0 && mkdir(outside, 0700) == 0);
  char sentinel[PATH_MAX]; path_at(sentinel, outside, "sentinel");
  int fd = open(sentinel, O_WRONLY | O_CREAT | O_EXCL, 0600); CHECK(fd >= 0); full_write(fd, OLD); CHECK(os_close(fd) == 0);
  existing_names(); concurrent_claims(); controlled_collision(); staging_collision(); before_publication_failures();
  after_publication_failures(); confinement_and_kinds(); modes_and_synchronization(); search_only_ancestor();
  complete_publication();
  case_name = "final-cleanup"; contents_at(outside, "sentinel", OLD); CHECK(staging_count() == 0); cleanup_tree(sandbox);
  puts("native publication: exclusive claims, collisions, real readers, failure phases, residuals, confinement, modes, fsync ordering passed");
  puts("durability limit: fsync success/order is exercised; hardware-cache flush and physical power-loss recovery are not proven");
  return 0;
}
