"""Codex Desktop IPC helper executable bootstrap.

The implementation lives in the sibling ``c2c_desktop_ipc`` package.  This
file only preserves the historical executable path and starts the package
dispatcher.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from typing import Any


def _bootstrap_package() -> Any:
    """Load the package next to this file without consulting import paths."""
    package_name = "c2c_desktop_ipc"
    package_dir = Path(__file__).with_name(package_name)
    init_path = package_dir / "__init__.py"
    if not package_dir.is_dir() or not init_path.is_file():
        raise ImportError(f"missing helper package: {package_dir}")

    def module_path(module: Any) -> Path | None:
        value = getattr(module, "__file__", None)
        if value is None:
            return None
        try:
            return Path(value).resolve()
        except (OSError, RuntimeError, TypeError, ValueError):
            return None

    package_root = package_dir.resolve()
    loaded = sys.modules.get(package_name)
    if loaded is not None and module_path(loaded) == init_path.resolve():
        prefix = f"{package_name}."
        descendants_are_local = True
        for name, module in sys.modules.items():
            if name == package_name or name.startswith(prefix):
                path = module_path(module)
                if path is None:
                    descendants_are_local = False
                    break
                try:
                    path.relative_to(package_root)
                except ValueError:
                    descendants_are_local = False
                    break
        if descendants_are_local:
            return loaded
    spec = importlib.util.spec_from_file_location(
        package_name, init_path, submodule_search_locations=[str(package_dir)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load helper package: {init_path}")

    # Clear the complete package namespace before execution.  Otherwise a
    # previous package with the same name can satisfy relative imports from a
    # different checkout and make the bootstrap non-deterministic.
    prefix = f"{package_name}."
    previous_modules = {
        name: module
        for name, module in sys.modules.items()
        if name == package_name or name.startswith(prefix)
    }
    try:
        for name in previous_modules:
            sys.modules.pop(name, None)
        package = importlib.util.module_from_spec(spec)
        sys.modules[package_name] = package
        spec.loader.exec_module(package)
    except BaseException:
        for name in list(sys.modules):
            if name == package_name or name.startswith(prefix):
                sys.modules.pop(name, None)
        sys.modules.update(previous_modules)
        raise
    return package


_PACKAGE = _bootstrap_package()


def main() -> int:
    return _PACKAGE.dispatch.main()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # 不把底层路径、正文或 traceback 输出到 helper 协议之外。
        raise SystemExit(1)
