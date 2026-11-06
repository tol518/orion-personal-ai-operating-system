"""Read-only Windows operations anchored to NT directory handles, including root traversal."""

import base64
import ctypes
import datetime
import json
import os
import re
import struct
import sys
import threading
import uuid
from ctypes import wintypes


class FileAccessError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class StreamInterrupted(Exception):
    """Bytes already went out, so the only honest answer left is to cut the transfer short."""


# A stream ends when its consumer stops reading; this bounds one that never does.
STREAM_SECONDS = 2 * 60 * 60


class NtStatusError(Exception):
    def __init__(self, status):
        super().__init__(hex(status))
        self.status = status


TRAVERSE, LIST, READ_DATA, READ_ATTRIBUTES, SYNCHRONIZE = 0x20, 0x1, 0x1, 0x80, 0x100000
DIRECTORY_FILE, SYNCHRONOUS_IO, NON_DIRECTORY_FILE, OPEN_REPARSE_POINT = 0x1, 0x20, 0x40, 0x200000
HIDDEN, SYSTEM, DIRECTORY, REPARSE_POINT, NAME_SURROGATE = 0x2, 0x4, 0x10, 0x400, 0x20000000
KNOWN_FOLDERS = [
    ("home", "Home", "5E6C858F-0E22-4760-9AFE-EA3317B67173"),
    ("desktop", "Desktop", "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"),
    ("documents", "Documents", "FDD39AD0-238F-46AF-ADB4-6C85480369C7"),
    ("downloads", "Downloads", "374DE290-123F-4565-9164-39C4925E467B"),
    ("pictures", "Pictures", "33E28130-4E1E-4676-835A-98395C3BC3BB"),
    ("music", "Music", "4BD8D571-6D19-48D3-BE97-422220080E43"),
    ("videos", "Videos", "18989B1D-99B5-455B-841C-AB7C74E4DDFC"),
]


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT), ("Buffer", ctypes.c_void_p)]


class OBJECT_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Length", wintypes.ULONG), ("RootDirectory", wintypes.HANDLE), ("ObjectName", ctypes.POINTER(UNICODE_STRING)),
                ("Attributes", wintypes.ULONG), ("SecurityDescriptor", ctypes.c_void_p), ("SecurityQualityOfService", ctypes.c_void_p)]


class IO_STATUS_BLOCK(ctypes.Structure):
    _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_size_t)]


class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [("Attributes", wintypes.DWORD), ("Created", wintypes.FILETIME), ("Accessed", wintypes.FILETIME),
                ("Written", wintypes.FILETIME), ("VolumeSerial", wintypes.DWORD), ("SizeHigh", wintypes.DWORD),
                ("SizeLow", wintypes.DWORD), ("Links", wintypes.DWORD), ("IndexHigh", wintypes.DWORD), ("IndexLow", wintypes.DWORD)]


class FILE_BASIC_INFO(ctypes.Structure):
    _fields_ = [("Created", ctypes.c_longlong), ("Accessed", ctypes.c_longlong), ("Written", ctypes.c_longlong),
                ("Changed", ctypes.c_longlong), ("Attributes", wintypes.DWORD)]


class OVERLAPPED(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t), ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD), ("Event", wintypes.HANDLE)]


def api():
    ntdll = ctypes.WinDLL("ntdll")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll.NtCreateFile.restype = ctypes.c_long
    ntdll.NtCreateFile.argtypes = [ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG, ctypes.POINTER(OBJECT_ATTRIBUTES),
                                   ctypes.POINTER(IO_STATUS_BLOCK), ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG,
                                   wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel32.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OVERLAPPED)]
    return ntdll, kernel32


def check(succeeded):
    if not succeeded:
        raise ctypes.WinError(ctypes.get_last_error())


def safe_name(name):
    return bool(name) and not name.startswith(".") and not name.endswith((" ", ".")) and not any(
        ord(char) < 32 or char in '\\/:*?"<>|' for char in name
    )


def nt_open(parent, name, access, options):
    # One component relative to an open directory handle; NTFS resolves it from that directory,
    # not from its current pathname. Reparse points are opened as themselves, never followed.
    text = ctypes.create_unicode_buffer(name)
    size = ctypes.sizeof(text) - ctypes.sizeof(ctypes.c_wchar)
    object_name = UNICODE_STRING(size, size + ctypes.sizeof(ctypes.c_wchar), ctypes.addressof(text))
    attributes = OBJECT_ATTRIBUTES(ctypes.sizeof(OBJECT_ATTRIBUTES), parent, ctypes.pointer(object_name), 0x40, None, None)
    handle = wintypes.HANDLE()
    status = NTDLL.NtCreateFile(ctypes.byref(handle), access | READ_ATTRIBUTES | SYNCHRONIZE, ctypes.byref(attributes),
                                ctypes.byref(IO_STATUS_BLOCK()), None, 0, 7, 1,
                                options | SYNCHRONOUS_IO | OPEN_REPARSE_POINT, None, 0)
    if status < 0:
        raise NtStatusError(status & 0xFFFFFFFF)
    return handle.value


def checked(handle, visible=True):
    tag = (wintypes.DWORD * 2)()
    check(KERNEL32.GetFileInformationByHandleEx(handle, 9, tag, ctypes.sizeof(tag)))
    if tag[0] & REPARSE_POINT and tag[1] & NAME_SURROGATE:
        raise FileAccessError("Linked files and folders are not shared.", 403)
    if visible and tag[0] & (HIDDEN | SYSTEM):
        raise FileAccessError("Only visible files inside shared folders are available.", 403)
    return tag[0]


def walk(parent, names, access, options, check_first):
    handle = None
    try:
        for index, name in enumerate(names):
            last = index == len(names) - 1
            child = nt_open(parent, name, access if last else TRAVERSE, options if last else DIRECTORY_FILE)
            if handle is not None:
                KERNEL32.CloseHandle(handle)
            handle = parent = child
            if name:
                checked(handle, visible=check_first)
        return handle
    except BaseException:
        if handle is not None:
            KERNEL32.CloseHandle(handle)
        raise


def open_root(path):
    if not isinstance(path, str) or "\x00" in path or not re.match(r"^[A-Za-z]:[\\/]", path):
        raise FileAccessError("Invalid shared folder.")
    names = [name for name in re.split(r"[\\/]+", path[3:]) if name]
    if any(name in (".", "..") for name in names):
        raise FileAccessError("Invalid shared folder.")
    volume = nt_open(None, "\\??\\%s:\\" % path[0].upper(), TRAVERSE, DIRECTORY_FILE)
    if not names:
        return volume
    try:
        # Ancestors may be hidden (a configured root under AppData), but never links.
        return walk(volume, names, TRAVERSE, DIRECTORY_FILE, False)
    finally:
        KERNEL32.CloseHandle(volume)


def open_target(root, parts, access, options):
    # An empty name reopens the root itself with the access this operation needs.
    return walk(root, parts or [""], access, options, True)


def describe(name, handle):
    info, basic = BY_HANDLE_FILE_INFORMATION(), FILE_BASIC_INFO()
    check(KERNEL32.GetFileInformationByHandle(handle, ctypes.byref(info)))
    check(KERNEL32.GetFileInformationByHandleEx(handle, 0, ctypes.byref(basic), ctypes.sizeof(basic)))
    directory = bool(info.Attributes & DIRECTORY)
    size = (info.SizeHigh << 32) | info.SizeLow
    modified = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(microseconds=basic.Written // 10)
    return {
        "name": name,
        "kind": "directory" if directory else "file",
        "sizeBytes": 0 if directory else size,
        "modifiedAt": modified.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "revision": "{}:{}:{}:{}:{}".format(info.VolumeSerial, (info.IndexHigh << 32) | info.IndexLow, size, basic.Written, basic.Changed),
    }


def scan(directory):
    buffer = ctypes.create_string_buffer(65536)
    view = memoryview(buffer)
    info_class = 15  # FileFullDirectoryRestartInfo, then FileFullDirectoryInfo
    while True:
        if not KERNEL32.GetFileInformationByHandleEx(directory, info_class, buffer, len(buffer)):
            error = ctypes.get_last_error()
            if error == 18:  # ERROR_NO_MORE_FILES
                return
            raise ctypes.WinError(error)
        info_class, offset = 14, 0
        while True:
            following = struct.unpack_from("<I", buffer, offset)[0]
            attributes, length, tag = struct.unpack_from("<III", buffer, offset + 56)
            try:
                yield bytes(view[offset + 68:offset + 68 + length]).decode("utf-16-le"), attributes, tag
            except UnicodeDecodeError:
                pass
            if not following:
                break
            offset += following


def read_at(handle, position, size):
    chunk, count = ctypes.create_string_buffer(size), wintypes.DWORD()
    overlapped = OVERLAPPED(0, 0, position & 0xFFFFFFFF, position >> 32, None)
    if not KERNEL32.ReadFile(handle, chunk, size, ctypes.byref(count), ctypes.byref(overlapped)):
        error = ctypes.get_last_error()
        if error == 38:  # ERROR_HANDLE_EOF
            return b""
        raise ctypes.WinError(error)
    return chunk.raw[:count.value]


def default_roots():
    shell32, ole32 = ctypes.WinDLL("shell32"), ctypes.WinDLL("ole32")
    shell32.SHGetKnownFolderPath.argtypes = [ctypes.c_char_p, wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p)]
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    roots = []
    for root_id, label, folder in KNOWN_FOLDERS:
        pointer = ctypes.c_void_p()
        if shell32.SHGetKnownFolderPath(uuid.UUID(folder).bytes_le, 0, None, ctypes.byref(pointer)) == 0:
            roots.append({"id": root_id, "label": label, "path": ctypes.wstring_at(pointer)})
        ole32.CoTaskMemFree(pointer)
    return roots


def operate(request, out=None):
    if sys.platform != "win32" or sys.version_info < (3, 8):
        raise FileAccessError("This device lacks hardened Windows filesystem support.", 501)
    configured = request.get("roots")
    if configured is None:
        configured = default_roots()
    operation = request.get("operation")
    if operation == "roots":
        roots = []
        for candidate in configured:
            try:
                KERNEL32.CloseHandle(open_root(candidate["path"]))
                roots.append({"id": candidate["id"], "label": candidate["label"]})
            except NtStatusError:
                pass
            except FileAccessError as error:
                if error.status != 403:
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
    if operation not in ("list", "stat", "read", "stream") or (operation == "stream" and out is None):
        raise FileAccessError("Unknown file operation.")
    if operation == "stat" and not parts:
        raise FileAccessError("Only regular files can be opened.")
    root_handle = open_root(root["path"])
    try:
        if operation == "list":
            target = open_target(root_handle, parts, LIST | TRAVERSE, DIRECTORY_FILE)
        else:
            target = open_target(root_handle, parts, 0 if operation == "stat" else READ_DATA, 0)
    finally:
        KERNEL32.CloseHandle(root_handle)
    try:
        if operation == "list":
            offset = request.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 5000:
                raise FileAccessError("Invalid folder page.")
            names = []
            truncated = False
            for name, attributes, tag in scan(target):
                if not safe_name(name) or attributes & (HIDDEN | SYSTEM) or (attributes & REPARSE_POINT and tag & NAME_SURROGATE):
                    continue
                if len(names) == 5000:
                    truncated = True
                    break
                names.append((name, bool(attributes & DIRECTORY)))
            names.sort(key=lambda entry: (not entry[1], entry[0].casefold(), entry[0]))
            entries = []
            for name, _ in names[offset:offset + 100]:
                # The scan is advisory; metadata comes from the entry opened beneath this handle.
                try:
                    item = nt_open(target, name, 0, 0)
                except NtStatusError:
                    continue
                try:
                    checked(item)
                    entries.append(describe(name, item))
                except FileAccessError:
                    pass
                finally:
                    KERNEL32.CloseHandle(item)
            return {"ok": True, "rootId": root["id"], "path": relative, "entries": entries,
                    "nextOffset": offset + 100 if offset + 100 < len(names) else None, "scanTruncated": truncated}
        result = describe(parts[-1], target)
        if result["kind"] != "file":
            raise FileAccessError("Only regular files can be opened.")
        revision = request.get("revision")
        if revision and revision != result["revision"]:
            raise FileAccessError("This file changed. Refresh the folder and open it again.", 409)
        if operation == "stat":
            return {"ok": True, **result}
        offset, length = request.get("offset"), request.get("length")
        limit = 2 ** 53 - 1 if operation == "stream" else 65536
        if type(offset) is not int or not 0 <= offset <= 2 ** 53 - 1 or type(length) is not int or not 1 <= length <= limit:
            raise FileAccessError("Invalid file range.")
        size = min(length, max(0, result["sizeBytes"] - offset))
        if operation == "stream":
            # One header line, then the range's raw bytes from this same handle.
            out.write(json.dumps({"ok": True, "offset": offset, "length": size}).encode("ascii") + b"\n")
            try:
                sent = 0
                while sent < size:
                    chunk = read_at(target, offset + sent, min(size - sent, 1 << 20))
                    if not chunk:
                        break
                    out.write(chunk)
                    sent += len(chunk)
                out.flush()
                if sent != size or describe(result["name"], target)["revision"] != result["revision"]:
                    raise FileAccessError("This file changed while it was being sent.", 409)
            except BaseException as error:
                raise StreamInterrupted(str(error)) from error
            return None
        data = bytearray()
        while len(data) < size:
            chunk = read_at(target, offset + len(data), size - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if describe(result["name"], target)["revision"] != result["revision"]:
            raise FileAccessError("This file changed. Refresh the folder and open it again.", 409)
        return {"ok": True, "offset": offset, "base64": base64.b64encode(data).decode("ascii")}
    finally:
        KERNEL32.CloseHandle(target)


def respond(request, out=None):
    try:
        return operate(request, out)
    except FileAccessError as error:
        return {"ok": False, "statusCode": error.status, "error": str(error)}
    except (NtStatusError, OSError) as error:
        code = error.status if isinstance(error, NtStatusError) else getattr(error, "winerror", None)
        status = {0xC0000034: 404, 0xC000003A: 404, 0xC000000F: 404, 0xC0000056: 404, 2: 404, 3: 404,
                  0xC0000022: 403, 0xC0000103: 403, 5: 403, 0xC0000043: 423, 32: 423}.get(code, 500)
        message = {404: "This file or folder is no longer available.",
                   403: "The device has not allowed access to this folder or a path component changed.",
                   423: "Another program on the device has this file locked."}.get(status, "The device could not read this file or folder.")
        return {"ok": False, "statusCode": status, "error": message}


if sys.platform == "win32":
    NTDLL, KERNEL32 = api()

if __name__ == "__main__":
    request = json.loads(base64.b64decode(sys.argv[1]))
    # The launcher can be terminated independently. Bound the helper's lifetime too.
    timer = threading.Timer(STREAM_SECONDS if request.get("operation") == "stream" else 15, os._exit, (124,))
    timer.daemon = True
    timer.start()
    try:
        result = respond(request, sys.stdout.buffer)
    except StreamInterrupted as error:
        sys.stderr.write(str(error)[:200])
        os._exit(3)
    if result is not None:
        print(json.dumps(result, ensure_ascii=True), flush=True)
