#!/usr/bin/env python3
"""Exec a command while holding a no-follow exclusive retained-volume lock."""

import fcntl
import os
import stat
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def inherited_fd(name: str) -> int:
    raw = os.environ.get(name, "")
    if not raw.isdigit():
        fail(f"{name} is missing or invalid")
    return int(raw)


def verify_inherited(root: str) -> None:
    try:
        root_fd = inherited_fd("ZAK_RADIO_VOLUME_ROOT_FD")
        lock_fd = inherited_fd("ZAK_RADIO_VOLUME_LOCK_FD")
        root_stat = os.fstat(root_fd)
        requested_stat = os.stat(root, follow_symlinks=False)
        lock_stat = os.fstat(lock_fd)
        rooted_lock_stat = os.stat(
            ".zak-radio-volume.lock", dir_fd=root_fd, follow_symlinks=False
        )
        if (
            not stat.S_ISDIR(root_stat.st_mode)
            or (root_stat.st_dev, root_stat.st_ino)
            != (requested_stat.st_dev, requested_stat.st_ino)
            or not stat.S_ISREG(lock_stat.st_mode)
            or lock_stat.st_nlink != 1
            or (lock_stat.st_dev, lock_stat.st_ino)
            != (rooted_lock_stat.st_dev, rooted_lock_stat.st_ino)
        ):
            fail("inherited retained-volume lifecycle lock does not match the volume")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ValueError) as error:
        fail(f"verify inherited retained-volume lifecycle lock: {error}")


if len(sys.argv) == 3 and sys.argv[1] == "--verify":
    verify_inherited(os.path.abspath(sys.argv[2]))
    raise SystemExit(0)


if len(sys.argv) < 4 or sys.argv[2] != "--":
    fail(
        "usage: with-volume-lock.py VOLUME -- COMMAND [ARG...] "
        "or with-volume-lock.py --verify VOLUME"
    )

root = os.path.abspath(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
try:
    root_fd = os.open(root, flags)
    lock_flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        lock_flags |= os.O_NOFOLLOW
    lock_fd = os.open(".zak-radio-volume.lock", lock_flags, 0o640, dir_fd=root_fd)
except OSError as error:
    fail(f"open retained-volume lifecycle lock: {error}")

lock_stat = os.fstat(lock_fd)
if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
    fail("retained-volume lifecycle lock is unsafe")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    fail("retained volume is active or another maintenance operation owns it")

os.set_inheritable(root_fd, True)
os.set_inheritable(lock_fd, True)
environment = os.environ.copy()
environment["ZAK_RADIO_VOLUME_ROOT_FD"] = str(root_fd)
environment["ZAK_RADIO_VOLUME_LOCK_FD"] = str(lock_fd)
os.execvpe(sys.argv[3], sys.argv[3:], environment)
