"""Deterministic junction swaps through the Windows handle-relative boundary. Runs on Windows only."""

import base64
import ctypes
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("device-file-windows.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def junction(link, target):
    import _winapi
    _winapi.CreateJunction(str(target), str(link))


@unittest.skipUnless(sys.platform == "win32", "Windows handle backend")
class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.shared = self.base / "shared"
        self.branch = self.shared / "branch"
        self.branch.mkdir(parents=True)
        (self.branch / "inside.txt").write_bytes(b"inside")
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "inside.txt").write_bytes(b"OUTSIDE-SECRET")

    def request(self, operation, path=None):
        return {"roots": [{"id": "docs", "label": "Docs", "path": str(self.shared)}],
                "rootId": "docs", "operation": operation,
                "path": path if path is not None else ("branch" if operation == "list" else "branch/inside.txt"),
                "offset": 0, "length": 64}

    def assert_inside(self, operation, result):
        self.assertTrue(result["ok"], result)
        if operation == "read":
            self.assertEqual(base64.b64decode(result["base64"]), b"inside")
        elif operation == "stat":
            self.assertEqual(result["sizeBytes"], 6)
        else:
            self.assertEqual([entry["name"] for entry in result["entries"]], ["inside.txt"])

    def swap(self, root, before, operation):
        victim = self.shared if root else self.branch
        original = worker.nt_open
        swapped = False

        def adversarial_open(parent, name, *args):
            nonlocal swapped
            match = name == victim.name and not swapped
            if match and before:
                swapped = True
                victim.rename(self.base / "held")
                junction(victim, self.outside)
            handle = original(parent, name, *args)
            if match and not before:
                swapped = True
                # The held handle has share-delete access, so the rename succeeds underneath it.
                victim.rename(self.base / "held")
                junction(victim, self.outside)
            return handle

        with patch.object(worker, "nt_open", adversarial_open):
            result = worker.respond(self.request(operation))
        self.assertTrue(swapped)
        if before:
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["statusCode"], 403)
        else:
            self.assert_inside(operation, result)

    def test_swaps_before_and_after_each_open_cannot_escape(self):
        for root in (False, True):
            for before in (False, True):
                for operation in ("list", "stat", "read"):
                    with self.subTest(root=root, before=before, operation=operation):
                        case = BoundaryTests()
                        case.setUp()
                        try:
                            case.swap(root, before, operation)
                        finally:
                            case.doCleanups()

    def test_static_junctions_hidden_and_system_entries_are_not_shared(self):
        junction(self.shared / "escape", self.outside)
        (self.shared / "hidden.txt").write_bytes(b"hidden")
        (self.shared / "system.txt").write_bytes(b"system")
        subprocess.run(["attrib", "+h", str(self.shared / "hidden.txt")], check=True)
        subprocess.run(["attrib", "+s", str(self.shared / "system.txt")], check=True)
        listing = worker.respond(self.request("list", ""))
        self.assertEqual([entry["name"] for entry in listing["entries"]], ["branch"])
        for path in ("escape/inside.txt", "hidden.txt", "system.txt", "escape"):
            result = worker.respond(self.request("read", path))
            self.assertEqual(result["statusCode"], 403, path)

    def test_short_names_and_stream_syntax_cannot_reach_hidden_entries(self):
        hidden = self.shared / "Hidden Folder Name"
        hidden.mkdir()
        (hidden / "x.txt").write_bytes(b"x")
        subprocess.run(["attrib", "+h", str(hidden)], check=True)
        short = ctypes.create_unicode_buffer(260)
        if ctypes.windll.kernel32.GetShortPathNameW(str(hidden), short, 260) and short.value != str(hidden):
            alias = Path(short.value).name
            self.assertEqual(worker.respond(self.request("read", alias + "/x.txt"))["statusCode"], 403)
        for path in ("branch/inside.txt::$DATA", "branch/inside.txt.", "branch/*", "..\\outside"):
            self.assertIn(worker.respond(self.request("read", path))["statusCode"], (400, 403), path)

    def test_file_symlink_is_not_followed(self):
        try:
            os.symlink(self.outside / "inside.txt", self.shared / "linked.txt")
        except OSError:
            self.skipTest("creating symbolic links needs Developer Mode or elevation")
        self.assertEqual(worker.respond(self.request("read", "linked.txt"))["statusCode"], 403)

    def test_configured_root_and_ancestor_junctions_are_refused(self):
        junction(self.base / "alias", self.base)
        request = self.request("read")
        request["roots"][0]["path"] = str(self.base / "alias" / "shared")
        self.assertEqual(worker.respond(request)["statusCode"], 403)
        request["operation"] = "roots"
        self.assertEqual(worker.respond(request), {"ok": True, "roots": []})
        for path in ("relative\\folder", "C:\\a\\..\\b", "\\\\server\\share"):
            request = self.request("roots")
            request["roots"][0]["path"] = path
            self.assertEqual(worker.respond(request)["statusCode"], 400, path)

    def test_reads_revisions_and_locked_files(self):
        stat = worker.respond(self.request("stat"))
        self.assert_inside("stat", stat)
        listing = worker.respond(self.request("list"))
        self.assertEqual(listing["entries"][0]["revision"], stat["revision"])
        request = self.request("read")
        request["revision"] = stat["revision"]
        self.assert_inside("read", worker.respond(request))
        (self.branch / "inside.txt").write_bytes(b"changed")
        self.assertEqual(worker.respond(request)["statusCode"], 409)
        request["revision"] = None
        request["offset"] = 3
        self.assertEqual(base64.b64decode(worker.respond(request)["base64"]), b"nged")
        self.assertEqual(worker.respond(self.request("read", "branch"))["statusCode"], 400)
        self.assertEqual(worker.respond(self.request("stat", "branch/missing.txt"))["statusCode"], 404)

    def test_defaults_include_the_home_folder_and_empty_shares_disable_sharing(self):
        self.assertEqual(worker.respond({"operation": "roots", "roots": []}), {"ok": True, "roots": []})
        roots = worker.respond({"operation": "roots"})["roots"]
        self.assertEqual(roots[0], {"id": "home", "label": "Home"})

    def test_failures_and_successes_close_handles(self):
        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetProcessHandleCount.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]

        def handles():
            count = ctypes.c_ulong()
            kernel32.GetProcessHandleCount(kernel32.GetCurrentProcess(), ctypes.byref(count))
            return count.value

        worker.respond(self.request("read"))
        before = handles()
        for _ in range(50):
            self.assert_inside("read", worker.respond(self.request("read")))
            self.assert_inside("list", worker.respond(self.request("list")))
            self.assertEqual(worker.respond(self.request("read", "branch/missing.txt"))["statusCode"], 404)
        self.assertLessEqual(handles(), before + 2)


if __name__ == "__main__":
    unittest.main()
