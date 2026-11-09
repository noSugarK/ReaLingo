import importlib.util
from pathlib import Path
import struct
import unittest
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("apk", Path(__file__).parents[1] / "scripts/check-android-apk.py")
apk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk)


def elf(alignment=16384, offset=0, address=0):
    data = bytearray(120)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 1)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, offset, address, 0, 0, 0, alignment)
    return data


class ApkAlignmentTests(unittest.TestCase):
    def test_aligned_library_passes(self):
        apk.check_elf(elf())

    def test_four_kilobyte_library_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not 16 KB aligned"):
            apk.check_elf(elf(4096))

    def test_mismatched_segment_offset_is_rejected(self):
        with self.assertRaises(ValueError):
            apk.check_elf(elf(offset=4096))

    def test_malformed_elf_is_rejected(self):
        with self.assertRaises(ValueError):
            apk.check_elf(b"bad")

    def test_all_libraries_in_the_apk_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "app.apk"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("lib/arm64-v8a/libapp.so", elf())
                archive.writestr("lib/arm64-v8a/libdependency.so", elf(4096))
            with self.assertRaisesRegex(ValueError, "libdependency.so"):
                apk.check_apk(path)

    def test_an_apk_without_native_libraries_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "empty.apk"
            with zipfile.ZipFile(path, "w"):
                pass
            with self.assertRaisesRegex(ValueError, "no native libraries"):
                apk.check_apk(path)


if __name__ == "__main__":
    unittest.main()
