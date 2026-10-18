import json
import tempfile
import unittest
from pathlib import Path

from check_licenses import allowed_license, check_cargo, check_npm


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


class ReviewedLicenseTests(unittest.TestCase):
    def test_reviewed_package_passes_only_with_the_reviewed_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-lock.json"
            reviewed = "sha512-LkBXKjU5r9vAW7Gcu3T5u+5cvSvh5WwINdr0C+9jpzVB41cjQAP5ePArDtk/WHYdVj0GefCgM73BA7FlIiNtdg=="
            path.write_text(json.dumps({"lockfileVersion": 3, "packages": {
                "": {},
                "node_modules/webgl-constants": {"version": "1.1.1", "integrity": reviewed},
            }}), encoding="utf-8")
            errors, _ = check_npm([path])
            self.assertEqual(errors, [])
            path.write_text(json.dumps({"lockfileVersion": 3, "packages": {
                "": {},
                "node_modules/webgl-constants": {"version": "1.1.2", "integrity": "sha512-other"},
            }}), encoding="utf-8")
            errors, _ = check_npm([path])
            self.assertEqual(len(errors), 1)


class CargoLicenseTests(unittest.TestCase):
    def test_crates_used_by_the_build_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.json"
            src = "registry+https://github.com/rust-lang/crates.io-index"
            packages = [
                {"id": "app", "name": "faztudo-desktop", "version": "0.1.3", "license": None, "source": None},
                {"id": "a", "name": "old-form", "version": "1.0.0", "license": "MIT/Apache-2.0", "source": src},
                {"id": "b", "name": "llvm", "version": "1.0.0", "license": "Apache-2.0 WITH LLVM-exception OR MIT", "source": src},
                {"id": "c", "name": "copyleft", "version": "1.0.0", "license": "GPL-3.0", "source": src},
                {"id": "d", "name": "unlicensed", "version": "1.0.0", "license": None, "source": src},
                {"id": "e", "name": "other-target", "version": "1.0.0", "license": "GPL-3.0", "source": src},
            ]
            nodes = [{"id": i} for i in ("app", "a", "b", "c", "d")]
            path.write_text(json.dumps({"packages": packages, "resolve": {"nodes": nodes}}), encoding="utf-8")
            errors, count = check_cargo([path])
            self.assertEqual(count, 4)
            self.assertEqual(sorted(e.split()[1] for e in errors), ["copyleft", "unlicensed"])

    def test_cargo_extras_stay_out_of_npm_and_go(self):
        self.assertFalse(allowed_license("Unicode-3.0"))
        self.assertFalse(allowed_license("Apache-2.0 WITH LLVM-exception"))


if __name__ == "__main__":
    unittest.main()
