import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("gradle_cache", Path(__file__).resolve().parents[1] / ".github/scripts/cache-gradle-kotlin.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GradleCacheTest(unittest.TestCase):
    def test_bundled_compiler_uses_gradles_exact_coordinate_and_content_hash(self):
        with tempfile.TemporaryDirectory() as root:
            distribution = Path(root) / "gradle.zip"
            content = b"bundled compiler fixture"
            with zipfile.ZipFile(distribution, "w") as archive:
                archive.writestr("gradle-8.14.3/lib/kotlin-compiler-embeddable-2.0.21.jar", content)
                archive.writestr("../../unrelated.jar", b"ignored")
            target = module.cache_compiler(distribution, root)
            self.assertEqual(target.read_bytes(), content)
            self.assertEqual(target.parent.name, hashlib.sha1(content).hexdigest())
            self.assertEqual(target.parent.parent.name, "2.0.21")
            self.assertEqual(target.parent.parent.parent.name, "kotlin-compiler-embeddable")


if __name__ == "__main__":
    unittest.main()
