import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("gradle_cache", Path(__file__).resolve().parents[1] / "scripts/cache-gradle-kotlin.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GradleCacheTest(unittest.TestCase):
    def test_bundled_compiler_preserves_its_official_maven_coordinate_and_pom(self):
        with tempfile.TemporaryDirectory() as root:
            distribution = Path(root) / "gradle.zip"
            content = b"bundled compiler fixture"
            with zipfile.ZipFile(distribution, "w") as archive:
                archive.writestr("gradle-8.14.3/lib/kotlin-compiler-embeddable-2.0.21.jar", content)
                archive.writestr("../../unrelated.jar", b"ignored")
            pom = b'<project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>kotlin-compiler-embeddable</artifactId><version>2.0.21</version><dependencies/></project>'
            target = module.cache_compiler(distribution, root, lambda url: pom)
            self.assertEqual(target.read_bytes(), content)
            self.assertEqual(target.with_suffix('.pom').read_bytes(), pom)
            self.assertEqual(target.parent.name, "2.0.21")
            self.assertEqual(target.parent.parent.name, "kotlin-compiler-embeddable")
            with self.assertRaisesRegex(ValueError, "POM does not match"):
                module.cache_compiler(distribution, root, lambda url: pom.replace(b'2.0.21', b'1.0'))


if __name__ == "__main__":
    unittest.main()
