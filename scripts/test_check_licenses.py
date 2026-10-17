import json
import tempfile
import unittest
from pathlib import Path

from check_licenses import allowed_license, check_npm


class LicenseCheckTests(unittest.TestCase):
    def test_license_expression_is_fail_closed(self):
        for value in ("MIT", "Apache-2.0 AND MIT", "(MIT OR BSD-3-Clause)"):
            self.assertTrue(allowed_license(value), value)
        for value in ("", "LGPL-3.0-or-later", "MIT OR", "MIT WITH LGPL-3.0-or-later", "CC-BY-4.0"):
            self.assertFalse(allowed_license(value), value)
        self.assertTrue(allowed_license("CC-BY-4.0", data_only=True))

    def test_production_packages_include_optional_and_missing_license(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-lock.json"
            path.write_text(json.dumps({"lockfileVersion": 3, "packages": {
                "": {},
                "node_modules/good": {"license": "MIT"},
                "node_modules/bad": {"license": "LGPL-3.0-or-later", "optional": True},
                "node_modules/missing": {},
                "node_modules/dev": {"license": "GPL-3.0", "dev": True},
            }}), encoding="utf-8")
            errors, count = check_npm([path])
            self.assertEqual(count, 3)
            self.assertEqual(len(errors), 2)
            self.assertTrue(any("node_modules/bad" in error for error in errors))
            self.assertTrue(any("node_modules/missing" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
