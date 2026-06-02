import os
import tempfile
import unittest

import importlib.util

# Load proxy-server.py (hyphenated filename) as a module.
_spec = importlib.util.spec_from_file_location(
    "proxy_server", os.path.join(os.path.dirname(__file__), "proxy-server.py")
)
proxy_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proxy_server)


class TailLinesTest(unittest.TestCase):
    def _write(self, text):
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        self.addCleanup(os.remove, path)
        return path

    def test_returns_last_n_lines(self):
        path = self._write("a\nb\nc\nd\ne\n")
        self.assertEqual(proxy_server.tail_lines(path, 2), ["d", "e"])

    def test_returns_all_when_n_exceeds_count(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 10), ["a", "b"])

    def test_missing_file_returns_empty(self):
        self.assertEqual(proxy_server.tail_lines("/no/such/file.log", 5), [])

    def test_ignores_trailing_blank_line_only(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 5), ["a", "b"])

    def test_zero_or_negative_returns_empty(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 0), [])
        self.assertEqual(proxy_server.tail_lines(path, -3), [])


if __name__ == "__main__":
    unittest.main()
