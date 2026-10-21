"""PTY for a stock CLI login. Relays bytes only; never records input or output.

fd 0/1 carry terminal bytes. Optional fd 3 carries "COLUMNS ROWS" lines for resizes.
SIGTERM, SIGINT or EOF on fd 0 stops the login: the CLI's process group gets SIGTERM,
then SIGKILL after STOP_GRACE_SECONDS. Callers should wait longer than that before
killing this helper, or the group outlives it.
"""
import errno
import fcntl
import os
import pty
import selectors
import signal
import struct
import sys
import termios

STOP_GRACE_SECONDS = 1

try:
    os.fstat(3)
    has_control = True
except OSError:
    has_control = False

# Signals wake the selector through a self-pipe, so the loop blocks instead of
# polling. Installed before fork so an early child exit cannot be missed.
wake_read, wake_write = os.pipe()
os.set_blocking(wake_read, False)
os.set_blocking(wake_write, False)
signal.set_wakeup_fd(wake_write)
signal.signal(signal.SIGCHLD, lambda *_: None)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    if has_control:
        os.close(3)
    os.execvp(sys.argv[1], sys.argv[1:])

os.close(slave)
# Set once the child is reaped. Until then its PID, and so its group ID, cannot be
# reused, even after it exits; afterwards the group is never signalled again.
reaped = False
stopping = False


def signal_group(sig):
    if reaped:
        return
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        # Gone, or (macOS) only the unreaped child is left in the group.
        pass


def terminate(*_):
    global stopping
    if not stopping:
        stopping = True
        signal_group(signal.SIGTERM)
        signal.alarm(STOP_GRACE_SECONDS)


def force_stop(*_):
    signal_group(signal.SIGKILL)


def exited():
    # WNOWAIT leaves the child unreaped, so cleanup can still signal its group.
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


signal.signal(signal.SIGALRM, force_stop)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
selector = selectors.DefaultSelector()
selector.register(wake_read, selectors.EVENT_READ)
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
if has_control:
    selector.register(3, selectors.EVENT_READ)
control = b""


def resize(data):
    global control
    control += data
    *lines, control = control.split(b"\n")
    control = control[-64:]
    for line in lines:
        try:
            columns, rows = (int(value) for value in line.split())
        except ValueError:
            continue
        if 20 <= columns <= 1000 and 5 <= rows <= 500:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            signal_group(signal.SIGWINCH)


try:
    while not exited():
        for key, _ in selector.select():
            if key.fd == wake_read:
                try:
                    while os.read(wake_read, 512):
                        pass
                except BlockingIOError:
                    pass
                continue
            try:
                data = os.read(key.fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                selector.unregister(key.fd)
                if key.fd == 0:
                    terminate()
                continue
            if key.fd == 3:
                resize(data)
                continue
            target = 1 if key.fd == master else master
            while data:
                data = data[os.write(target, data):]
finally:
    signal.alarm(0)
    # Whatever the group left running ends with the login. This is the group's
    # only SIGKILL after exit, and it precedes the reap that frees the ID.
    signal_group(signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    reaped = True
    os.set_blocking(master, False)
    while True:
        try:
            data = os.read(master, 4096)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break
    os.close(master)
    selector.close()
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
