"""Reuse Gradle's bundled Kotlin compiler in its checksum-addressed artifact cache."""
import hashlib
from pathlib import Path
import re
import sys
import zipfile


def cache_compiler(distribution, gradle_home):
    with zipfile.ZipFile(distribution) as archive:
        for name in archive.namelist():
            match = re.fullmatch(r"gradle-[\d.]+/lib/(kotlin-compiler-embeddable-([\d.]+)\.jar)", name)
            if not match:
                continue
            filename, version = match.groups()
            content = archive.read(name)
            checksum = hashlib.sha1(content).hexdigest()
            target = Path(gradle_home) / "caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-compiler-embeddable" / version / checksum / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            print(f"Cached bundled Kotlin compiler {version}: {checksum}")
            return target
    raise ValueError("Verified Gradle distribution contains no Kotlin compiler")


if __name__ == "__main__":
    cache_compiler(sys.argv[1], sys.argv[2])
