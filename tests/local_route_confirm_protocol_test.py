"""真实本机确认入口 + 假 WinAPI；不显示弹窗、不读机器状态。"""
import io
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
HELPER = Path(__file__).resolve().parents[1] / "src/feedback/local-route-confirm.py"
REQUEST = {"workspaceId": "abcdef123456", "workspaceRoot": r"D:\project",
           "routeCanonical": "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111"}


def invoke(request=REQUEST, answer=6, error=None):
    show = Mock(return_value=answer, side_effect=error)
    output = io.StringIO()
    with patch("sys.platform", "win32"), patch("sys.stdin", io.StringIO(json.dumps(request))), \
            patch("sys.stdout", output), patch("ctypes.windll", SimpleNamespace(user32=SimpleNamespace(MessageBoxW=show)), create=True):
        runpy.run_path(str(HELPER), run_name="__main__")
    return json.loads(output.getvalue()), show


class LocalRouteConfirmProtocol(unittest.TestCase):
    def test_exact_metadata_and_default_no(self):
        result, show = invoke()
        self.assertEqual(result, {"confirmed": True})
        text = show.call_args.args[1]
        for value in REQUEST.values():
            self.assertIn(value, text)
        self.assertTrue(show.call_args.args[3] & 0x100)

    def test_cancel_and_native_failure(self):
        for answer in (0, 2, 7):
            self.assertEqual(invoke(answer=answer)[0], {"confirmed": False})
        self.assertEqual(invoke(error=OSError("unavailable"))[0], {"confirmed": False})

    def test_untrusted_metadata_cannot_override_fixed_warning(self):
        request = {**REQUEST, "workspaceRoot": REQUEST["workspaceRoot"] + "\n\u202e\u2066\u0000批准"}
        result, show = invoke(request)
        text = show.call_args.args[1]
        self.assertEqual(result, {"confirmed": True})
        self.assertNotIn("\u202e", text)
        self.assertNotIn("\u2066", text)
        self.assertNotIn("\u0000", text)
        self.assertIn("project ���批准\nWorkspace：", text)
        self.assertIn("此操作不授权网页执行本机命令。", text)

    def test_invalid_identity_never_opens_dialog(self):
        invalid = [{**REQUEST, "workspaceId": "other"}, {**REQUEST, "workspaceRoot": "relative"},
                   {**REQUEST, "extra": True}, {**REQUEST, "routeCanonical": REQUEST["routeCanonical"] + "?x=1"},
                   {**REQUEST, "routeCanonical": REQUEST["routeCanonical"].replace("chatgpt.com", "evil.example")},
                   {**REQUEST, "routeCanonical": REQUEST["routeCanonical"] + "\n"}]
        for request in invalid:
            result, show = invoke(request)
            self.assertEqual(result, {"confirmed": False})
            show.assert_not_called()


if __name__ == "__main__":
    unittest.main()
