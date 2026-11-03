"""Read-only operations anchored to directory descriptors, including root traversal."""

import base64
import datetime
import errno
import json
import os
import signal
import stat
import sys


class FileAccessError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def safe_name(name):
    return bool(name) and not name.startswith(".") and not any(
        ord(char) < 32 or char in "\\/:" for char in name
    )


def directory_flags():
    access = os.O_SEARCH if sys.platform == "darwin" else os.O_PATH
    return access | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def open_root(path):
    if not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path:
        raise FileAccessError("Invalid shared folder.")
    # Open ONE component relative to each pinned parent, including the root's ancestors.
    descriptor = os.open("/", directory_flags())
    try:
        for name in os.path.normpath(path).split("/"):
            if not name:
                continue
            child = os.open(name, directory_flags(), dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_target(root, parts, directory):
    descriptor = os.dup(root)
    try:
        for index, name in enumerate(parts):
            flags = directory_flags() if directory or index < len(parts) - 1 else (
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            )
            child = os.open(name, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def describe(name, info):
    return {
        "name": name,
        "kind": "directory" if stat.S_ISDIR(info.st_mode) else "file",
        "sizeBytes": info.st_size if stat.S_ISREG(info.st_mode) else 0,
        "modifiedAt": datetime.datetime.fromtimestamp(
            info.st_mtime, datetime.timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "revision": "{}:{}:{}:{}:{}".format(info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns),
    }


def operate(request):
    if (sys.version_info < (3, 8) or sys.platform not in ("darwin", "linux")
            or os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks or os.scandir not in os.supports_fd
            or not all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC", "O_NONBLOCK", "pread", "O_SEARCH" if sys.platform == "darwin" else "O_PATH"))):
        raise FileAccessError("This device lacks hardened filesystem support.", 501)
    configured = request.get("roots")
    if configured is None:
        names = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies" if sys.platform == "darwin" else "Videos"]
        configured = [{"id": name.lower(), "label": name, "path": os.path.join(os.path.expanduser("~"), name)} for name in names]
    operation = request.get("operation")
    if operation == "roots":
        roots = []
        for candidate in configured:
            try:
                descriptor = open_root(candidate["path"])
                os.close(descriptor)
                roots.append({"id": candidate["id"], "label": candidate["label"]})
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EACCES, errno.EPERM):
                    raise
        return {"ok": True, "roots": roots}
    root = next((root for root in configured if root["id"] == request.get("rootId")), None)
    if root is None:
        raise FileAccessError("This folder is not shared by the device.", 404)
    relative = request.get("path", "")
    if not isinstance(relative, str) or len(relative) > 2048:
        raise FileAccessError("Invalid file path.")
    parts = relative.split("/") if relative else []
    if any(not safe_name(part) for part in parts):
        raise FileAccessError("Only visible files inside shared folders are available.", 403)
    if operation not in ("list", "stat", "read"):
        raise FileAccessError("Unknown file operation.")
    if operation == "stat" and not parts:
        raise FileAccessError("Only regular files can be opened.")
    root_fd = open_root(root["path"])
    try:
        target = open_target(root_fd, parts[:-1] if operation == "stat" else parts, operation != "read")
    finally:
        os.close(root_fd)
    try:
        if operation == "list":
            # Enumeration needs read permission only on this already-pinned directory.
            readable = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=target)
            os.close(target)
            target = readable
        info = os.stat(parts[-1], dir_fd=target, follow_symlinks=False) if operation == "stat" else os.fstat(target)
        if stat.S_ISLNK(info.st_mode):
            raise FileAccessError("Linked files and folders are not shared.", 403)
        if operation == "list":
            offset = request.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 5000:
                raise FileAccessError("Invalid folder page.")
            names = []
            truncated = False
            with os.scandir(target) as directory:
                for entry in directory:
                    if not safe_name(entry.name) or not (entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)):
                        continue
                    if len(names) == 5000:
                        truncated = True
                        break
                    names.append((entry.name, entry.is_dir(follow_symlinks=False)))
            names.sort(key=lambda entry: (not entry[1], entry[0].casefold(), entry[0]))
            entries = []
            for name, _ in names[offset:offset + 100]:
                try:
                    item = os.stat(name, dir_fd=target, follow_symlinks=False)
                    if stat.S_ISREG(item.st_mode) or stat.S_ISDIR(item.st_mode):
                        entries.append(describe(name, item))
                except OSError as error:
                    if error.errno not in (errno.ENOENT, errno.EACCES, errno.EPERM):
                        raise
            return {"ok": True, "rootId": root["id"], "path": relative, "entries": entries,
                    "nextOffset": offset + 100 if offset + 100 < len(names) else None, "scanTruncated": truncated}
        if not stat.S_ISREG(info.st_mode):
            raise FileAccessError("Only regular files can be opened.")
        result = describe(parts[-1], info)
        revision = request.get("revision")
        if revision and revision != result["revision"]:
            raise FileAccessError("This file changed. Refresh the folder and open it again.", 409)
        if operation == "stat":
            return {"ok": True, **result}
        offset, length = request.get("offset"), request.get("length")
        if type(offset) is not int or not 0 <= offset <= 2 ** 53 - 1 or type(length) is not int or not 1 <= length <= 65536:
            raise FileAccessError("Invalid file range.")
        size = min(length, max(0, info.st_size - offset))
        data = bytearray()
        while len(data) < size:
            chunk = os.pread(target, size - len(data), offset + len(data))
            if not chunk:
                break
            data.extend(chunk)
        if describe(result["name"], os.fstat(target))["revision"] != result["revision"]:
            raise FileAccessError("This file changed. Refresh the folder and open it again.", 409)
        return {"ok": True, "offset": offset, "base64": base64.b64encode(data).decode("ascii")}
    finally:
        os.close(target)


def respond(request):
    try:
        return operate(request)
    except FileAccessError as error:
        return {"ok": False, "statusCode": error.status, "error": str(error)}
    except OSError as error:
        status = {errno.ENOENT: 404, errno.ENOTDIR: 403, errno.ELOOP: 403, errno.EACCES: 403, errno.EPERM: 403}.get(error.errno, 500)
        message = "This file or folder is no longer available." if status == 404 else (
            "The device has not allowed access to this folder or a path component changed." if status == 403 else "The device could not read this file or folder.")
        return {"ok": False, "statusCode": status, "error": message}


if __name__ == "__main__":
    # An outer Node host can be terminated independently. Bound the helper's lifetime too.
    signal.alarm(15)
    print(json.dumps(respond(json.loads(base64.b64decode(sys.argv[1]))), ensure_ascii=True))
