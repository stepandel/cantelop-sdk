"""PTY for a stock CLI login. Relays bytes only; never records input or output.

fd 0/1 carry terminal bytes. Optional fd 3 carries "COLUMNS ROWS" lines for resizes.
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
import time

try:
    os.fstat(3)
    has_control = True
except OSError:
    has_control = False
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
stopping = None

def terminate(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        signal.alarm(2)
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

def force_stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os._exit(1)

signal.signal(signal.SIGALRM, force_stop)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
selector = selectors.DefaultSelector()
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
            try:
                os.killpg(pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

status = None
try:
    while True:
        if stopping is not None and time.monotonic() - stopping > 1:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for key, _ in selector.select(0.05):
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
        ended, value = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = value
            break
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if status is None:
        _, status = os.waitpid(pid, 0)
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
