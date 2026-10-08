"""单次本机 route 确认；只从 stdin 读取已验证 workspace/URL，不持久化授权。"""
import ctypes
import json
import ntpath
import re
import sys
import unicodedata


def _display_metadata(value):
    """沿用 Desktop 确认框的单行规则，控制符/bidi 不得改写固定文案。"""
    result = []
    for char in value:
        category = unicodedata.category(char)
        if char in "\r\n\t" or category in {"Zl", "Zp"}:
            result.append(" ")
        elif category.startswith("C"):
            result.append("�")
        else:
            result.append(char)
    return "".join(result).strip() or "(未命名)"


def main():
    if sys.platform != "win32":
        return False
    request = json.loads(sys.stdin.read(8193))
    if set(request) != {"workspaceId", "workspaceRoot", "routeCanonical"}:
        return False
    if not all(isinstance(value, str) and 0 < len(value) <= 4096 for value in request.values()):
        return False
    if not re.fullmatch(r"[a-f0-9]{12}", request["workspaceId"]) or not ntpath.isabs(request["workspaceRoot"]):
        return False
    route = request["routeCanonical"]
    route_match = re.fullmatch(r"https://chatgpt\.com/(?:g/(g-[A-Za-z0-9_-]+)/)?c/"
                              r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", route)
    if not route_match or len(route) > 512:
        return False
    gpt_id = route_match.group(1)
    project = re.fullmatch(r"g-p-([0-9a-fA-F]{32})(?:-[A-Za-z0-9_-]+)?", gpt_id or "")
    if project and gpt_id != "g-p-" + project.group(1).lower():
        return False
    message = (
        "允许此 ChatGPT 对话成为当前项目的结果接收页面？\n\n"
        "项目目录：" + _display_metadata(request["workspaceRoot"]) + "\n"
        "Workspace：" + request["workspaceId"] + "\n\n"
        "完整对话 URL：\n" + request["routeCanonical"] + "\n\n"
        "确认后切换当前接收页面；此操作不授权网页执行本机命令。"
    )
    show = ctypes.windll.user32.MessageBoxW
    show.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
    show.restype = ctypes.c_int
    # YESNO + ICONQUESTION + DEFBUTTON2 + SETFOREGROUND；关闭/取消默认拒绝。
    return show(None, message, "Codex with ChatGPT — 连接对话", 0x00010000 | 0x00000100 | 0x20 | 0x04) == 6


if __name__ == "__main__":
    try:
        confirmed = main()
    except Exception:
        confirmed = False
    print(json.dumps({"confirmed": confirmed}, separators=(",", ":")))
