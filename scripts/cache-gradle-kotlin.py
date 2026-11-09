"""Expose Gradle's bundled Kotlin compiler and its official POM in a local Maven repo."""
import hashlib
from pathlib import Path
import re
import sys
import zipfile
import urllib.request
import xml.etree.ElementTree as ET


def cache_compiler(distribution, repository, read_pom=None):
    with zipfile.ZipFile(distribution) as archive:
        for name in archive.namelist():
            match = re.fullmatch(r"gradle-[\d.]+/lib/(kotlin-compiler-embeddable-([\d.]+)\.jar)", name)
            if not match:
                continue
            filename, version = match.groups()
            content = archive.read(name)
            checksum = hashlib.sha1(content).hexdigest()
            target = Path(repository) / "org/jetbrains/kotlin/kotlin-compiler-embeddable" / version / filename
            url = f"https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-compiler-embeddable/{version}/kotlin-compiler-embeddable-{version}.pom"
            if read_pom:
                pom = read_pom(url)
            else:
                with urllib.request.urlopen(url, timeout=30) as response:
                    pom = response.read()
            metadata = ET.fromstring(pom)
            ns = "{http://maven.apache.org/POM/4.0.0}"
            if metadata.findtext(ns + "artifactId") != "kotlin-compiler-embeddable" or metadata.findtext(ns + "version") != version:
                raise ValueError("Official POM does not match the bundled Kotlin compiler")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.with_suffix('.pom').write_bytes(pom)
            print(f"Cached bundled Kotlin compiler {version}: {checksum}")
            return target
    raise ValueError("Verified Gradle distribution contains no Kotlin compiler")


if __name__ == "__main__":
    cache_compiler(sys.argv[1], sys.argv[2])
