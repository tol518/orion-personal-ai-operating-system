"""Deterministic adversarial swaps through the production filesystem boundary."""

import base64
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("device-file-posix.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


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
        (self.outside / "outside-only.txt").write_bytes(b"SECRET")

    def request(self, operation):
        return {"roots": [{"id": "docs", "label": "Docs", "path": str(self.shared)}],
                "rootId": "docs", "operation": operation,
                "path": "branch" if operation == "list" else "branch/inside.txt",
                "offset": 0, "length": 64}

    def assert_inside(self, operation, result):
        self.assertTrue(result["ok"], result)
        if operation == "read":
            self.assertEqual(base64.b64decode(result["base64"]), b"inside")
        elif operation == "stat":
            self.assertEqual(result["sizeBytes"], 6)
        else:
            self.assertEqual([entry["name"] for entry in result["entries"]], ["inside.txt"])
            self.assertEqual(result["entries"][0]["sizeBytes"], 6)

    def swap(self, root, before, operation):
        victim = self.shared if root else self.branch
        original = worker.os.open
        swapped = False

        def adversarial_open(name, flags, *args, **kwargs):
            nonlocal swapped
            match = name == victim.name and "dir_fd" in kwargs and not swapped
            if match and before:
                swapped = True
                victim.rename(self.base / "held")
                victim.symlink_to(self.outside, target_is_directory=True)
            descriptor = original(name, flags, *args, **kwargs)
            if match and not before:
                swapped = True
                victim.rename(self.base / "held")
                victim.symlink_to(self.outside, target_is_directory=True)
            return descriptor

        supported = worker.os.supports_dir_fd | {adversarial_open}
        with patch.object(worker.os, "open", adversarial_open), patch.object(worker.os, "supports_dir_fd", supported):
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
                        # Separate paths for each destructive swap.
                        case = BoundaryTests()
                        case.setUp()
                        try:
                            case.swap(root, before, operation)
                        finally:
                            case.doCleanups()

    def test_final_file_swap_is_not_followed(self):
        original = worker.os.open
        def adversarial_open(name, flags, *args, **kwargs):
            if name == "inside.txt":
                target = self.branch / name
                target.unlink()
                target.symlink_to(self.outside / name)
            return original(name, flags, *args, **kwargs)
        with patch.object(worker.os, "open", adversarial_open), patch.object(worker.os, "supports_dir_fd", worker.os.supports_dir_fd | {adversarial_open}):
            result = worker.respond(self.request("read"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["statusCode"], 403)

    def test_list_metadata_does_not_follow_a_replaced_entry(self):
        original = worker.os.stat
        def adversarial_stat(name, *args, **kwargs):
            if name == "inside.txt":
                target = self.branch / name
                target.unlink()
                target.symlink_to(self.outside / name)
            return original(name, *args, **kwargs)
        with patch.object(worker.os, "stat", adversarial_stat), patch.object(worker.os, "supports_dir_fd", worker.os.supports_dir_fd | {adversarial_stat}), patch.object(worker.os, "supports_follow_symlinks", worker.os.supports_follow_symlinks | {adversarial_stat}):
            result = worker.respond(self.request("list"))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["entries"], [])

    def test_missing_descriptor_api_and_windows_fail_closed(self):
        with patch.object(worker.os, "supports_fd", set()):
            self.assertEqual(worker.respond(self.request("read"))["statusCode"], 501)
        with patch.object(worker.sys, "platform", "win32"):
            self.assertEqual(worker.respond(self.request("read"))["statusCode"], 501)

    def test_configured_root_and_ancestor_links_are_refused(self):
        alias = self.base / "alias"
        alias.symlink_to(self.base, target_is_directory=True)
        request = self.request("read")
        request["roots"][0]["path"] = str(alias / "shared")
        self.assertEqual(worker.respond(request)["statusCode"], 403)
        self.shared.rename(self.base / "held")
        self.shared.symlink_to(self.outside, target_is_directory=True)
        self.assertEqual(worker.respond(self.request("list"))["statusCode"], 403)
        request = self.request("roots")
        self.assertEqual(worker.respond(request), {"ok": True, "roots": []})

    def test_empty_shares_metadata_permissions_and_special_files(self):
        self.assertEqual(worker.respond({"operation": "roots", "roots": []}), {"ok": True, "roots": []})
        file = self.branch / "inside.txt"
        file.chmod(0)
        try:
            self.assert_inside("stat", worker.respond(self.request("stat")))
        finally:
            file.chmod(0o600)
        file.unlink()
        os.mkfifo(file)
        self.assertEqual(worker.respond(self.request("read"))["statusCode"], 400)

    def test_search_only_ancestors_do_not_require_directory_read_permission(self):
        self.base.chmod(0o111)
        self.shared.chmod(0o111)
        try:
            self.assertEqual((self.branch / "inside.txt").read_bytes(), b"inside")
            self.assert_inside("read", worker.respond(self.request("read")))
            self.assert_inside("stat", worker.respond(self.request("stat")))
            self.assert_inside("list", worker.respond(self.request("list")))
            result = worker.respond(self.request("roots"))
            self.assertEqual(result["roots"], [{"id": "docs", "label": "Docs"}])
        finally:
            self.base.chmod(0o700)
            self.shared.chmod(0o700)

    def test_scan_limit_is_reported_without_returning_unbounded_metadata(self):
        for index in range(5002):
            (self.branch / ("item-%04d.txt" % index)).touch()
        result = worker.respond(self.request("list"))
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["scanTruncated"])
        self.assertEqual(len(result["entries"]), 100)

    def test_failures_and_successes_close_descriptors(self):
        count = len(os.listdir("/dev/fd"))
        for _ in range(20):
            self.assert_inside("read", worker.respond(self.request("read")))
            request = self.request("read")
            request["path"] = "branch/missing.txt"
            self.assertEqual(worker.respond(request)["statusCode"], 404)
        self.assertEqual(len(os.listdir("/dev/fd")), count)


if __name__ == "__main__":
    unittest.main()
