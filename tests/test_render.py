import contextlib
import io
import struct
import tempfile
import unittest
from pathlib import Path

import render_map as cli
from wardley_map import MapValidationError, load_map, render_map

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "maps" / "bike-repair-service.yaml"
QUIZ = ROOT / "maps" / "quiz-tea-stall.yaml"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(path):
    with open(path, "rb") as handle:
        header = handle.read(24)
    assert header[:8] == PNG_MAGIC, "not a PNG file"
    return struct.unpack(">II", header[16:24])


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_smoke_render_writes_png(self):
        target = render_map(load_map(EXAMPLE), self.out / "nested" / "map.png")
        self.assertTrue(target.exists())
        width, height = png_size(target)
        self.assertGreater(width, 800)
        self.assertGreater(height, 500)
        self.assertGreater(target.stat().st_size, 10_000)

    def test_small_size_is_smaller(self):
        mapdef = load_map(QUIZ)
        large = png_size(render_map(mapdef, self.out / "large.png", size="large"))
        small = png_size(render_map(mapdef, self.out / "small.png", size="small"))
        self.assertLess(small[0], large[0])

    def test_render_rejects_invalid_map(self):
        mapdef = load_map(QUIZ)
        mapdef["dependencies"].append({"from": "tea", "to": "sugar"})
        with self.assertRaises(MapValidationError):
            render_map(mapdef, self.out / "bad.png")
        self.assertFalse((self.out / "bad.png").exists())

    def test_unknown_size(self):
        with self.assertRaises(ValueError):
            render_map(load_map(QUIZ), self.out / "x.png", size="poster")


class CliTest(unittest.TestCase):
    def run_cli(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(list(argv))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_check_folder(self):
        code, out, _ = self.run_cli(str(ROOT / "maps"), "--check")
        self.assertEqual(code, 0)
        self.assertIn("bike-repair-service.yaml", out)

    def test_render_to_out_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, _ = self.run_cli(str(QUIZ), "--out-dir", tmp, "--size", "small")
            self.assertEqual(code, 0)
            self.assertTrue((Path(tmp) / "quiz-tea-stall.png").exists())

    def test_invalid_file_gives_exit_code_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.yaml"
            bad.write_text("components:\n  - {id: a, name: A, evolution: 2, value: 0.5}\n", encoding="utf-8")
            code, _, err = self.run_cli(str(bad), "--check")
            self.assertEqual(code, 1)
            self.assertIn("must be between 0 and 1", err)

    def test_output_needs_single_input(self):
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()):
            cli.main([str(EXAMPLE), str(QUIZ), "-o", "x.png"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
