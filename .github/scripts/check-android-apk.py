"""Check every native library, not only the outer APK's ZIP alignment (stdlib only)."""
import struct
import sys
import zipfile


def check_elf(data):
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("expected little-endian ELF64")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    loads = 0
    for index in range(phnum):
        kind, _, offset, address, _, _, _, alignment = struct.unpack_from(
            "<IIQQQQQQ", data, phoff + index * phsize
        )
        if kind == 1:  # PT_LOAD
            loads += 1
            if alignment < 16384 or alignment & (alignment - 1) or offset % 16384 != address % 16384:
                raise ValueError(f"PT_LOAD {index} is not 16 KB aligned (alignment={alignment})")
    if not loads:
        raise ValueError("ELF contains no loadable segments")


def check_apk(path):
    with zipfile.ZipFile(path) as apk:
        libraries = [name for name in apk.namelist() if name.startswith("lib/") and name.endswith(".so")]
        if not libraries:
            raise ValueError("APK contains no native libraries")
        for name in libraries:
            try:
                check_elf(apk.read(name))
            except (ValueError, struct.error) as error:
                raise ValueError(f"{name}: {error}") from error
            print(f"16 KB ELF alignment OK: {name}")


if __name__ == "__main__":
    check_apk(sys.argv[1])
