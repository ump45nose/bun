// LD_PRELOAD shim that stands in for a file system that reports a write error
// at close(2), as NFS, SMB and FUSE can do for ENOSPC, EDQUOT and EIO.
//
// It acts on a file whose name ends with ".<errno>.close-fault", for example
// "copy.28.close-fault" for ENOSPC, through a descriptor that is open for
// writing. The first close of such a file releases the descriptor, as the
// kernel does, and then fails with that errno. A later close of the same file
// succeeds: the error is reported once, by the close that follows the write.
// With CLOSE_FAULT_READERS set, a descriptor that is open for reading counts
// too (FUSE calls flush for each close).
//
// Each close of such a file writes one line to stderr. bun closes through
// syscall(SYS_close, fd), so syscall() is the symbol to interpose. glibc only.
#define _GNU_SOURCE
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define SUFFIX ".close-fault"
#define MAX_FILES 64

static long (*next_syscall)(long, ...);
static struct {
  dev_t dev;
  ino_t ino;
} reported[MAX_FILES];
static int reported_count;
static volatile int lock;

// The errno to report for this close. 0: the error was reported before.
// -1: not a file of interest.
static int fault_for(int fd) {
  char link[64], target[4096];
  struct stat st;
  if (fd < 3) return -1;
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -1;
  if ((flags & O_ACCMODE) == O_RDONLY && !getenv("CLOSE_FAULT_READERS")) return -1;
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, target, sizeof target - 1);
  if (n <= (ssize_t)strlen(SUFFIX)) return -1;
  target[n] = 0;
  char *suffix = target + n - strlen(SUFFIX);
  if (strcmp(suffix, SUFFIX) != 0) return -1;
  char *digits = suffix;
  while (digits > target && isdigit((unsigned char)digits[-1])) digits--;
  if (digits == suffix || digits == target || digits[-1] != '.') return -1;
  int fault = atoi(digits);
  if (fstat(fd, &st) != 0) return -1;

  while (__sync_lock_test_and_set(&lock, 1)) {
  }
  for (int i = 0; i < reported_count; i++) {
    if (reported[i].dev == st.st_dev && reported[i].ino == st.st_ino) fault = 0;
  }
  if (fault != 0 && reported_count < MAX_FILES) {
    reported[reported_count].dev = st.st_dev;
    reported[reported_count].ino = st.st_ino;
    reported_count++;
  }
  __sync_lock_release(&lock);
  return fault;
}

long syscall(long nr, ...) {
  va_list ap;
  va_start(ap, nr);
  long a1 = va_arg(ap, long), a2 = va_arg(ap, long), a3 = va_arg(ap, long);
  long a4 = va_arg(ap, long), a5 = va_arg(ap, long), a6 = va_arg(ap, long);
  va_end(ap);
  if (!next_syscall) next_syscall = dlsym(RTLD_NEXT, "syscall");
  if (nr != SYS_close) return next_syscall(nr, a1, a2, a3, a4, a5, a6);

  int fault = fault_for((int)a1);
  long rc = next_syscall(nr, a1);
  if (fault < 0 || rc != 0) return rc;
  if (fault == 0) {
    dprintf(2, "close-fault: ok\n");
    return 0;
  }
  dprintf(2, "close-fault: errno %d\n", fault);
  errno = fault;
  return -1;
}
