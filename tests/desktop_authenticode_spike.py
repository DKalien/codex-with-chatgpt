"""只读 Authenticode feasibility spike；不参与 production trust decisions。"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import sys
import unicodedata

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/desktop/helper"))
import desktop_ipc


_VERIFY_V2 = 0x00AAC56B, 0xCD44, 0x11D0, (0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE)
_UNAVAILABLE_TRUST_CODES = {
    0x800B0001, 0x800B0002, 0x800B0003,  # 信任提供程序、动作或主体类型不可用
    0x80070002, 0x80070003, 0x80070005, 0x80070020,  # 文件缺失、拒绝访问或共享冲突
}
_INVALID_TRUST_REASONS = {
    0x800B0004: "publisher_not_trusted",
    0x800B0100: "no_signature",
    0x800B0101: "certificate_expired",
    0x800B0109: "untrusted_root",
    0x800B010C: "certificate_revoked",
    0x800B0110: "wrong_usage",
    0x800B0111: "explicit_distrust",
    0x80096010: "bad_digest",
}
_MAX_NAME_CHARS = 4096
_MAX_PUBLISHER_CHARS = 256
_MAX_CERTIFICATE_BYTES = 64 * 1024


class _Guid(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                ("Data4", wintypes.BYTE * 8)]


class _WinTrustFileInfo(ctypes.Structure):
    _fields_ = [("cbStruct", wintypes.DWORD), ("pcwszFilePath", wintypes.LPCWSTR),
                ("hFile", wintypes.HANDLE), ("pgKnownSubject", ctypes.POINTER(_Guid))]


class _WinTrustChoice(ctypes.Union):
    _fields_ = [("pFile", ctypes.POINTER(_WinTrustFileInfo)), ("pointer", ctypes.c_void_p)]


class _WinTrustData(ctypes.Structure):
    _fields_ = [("cbStruct", wintypes.DWORD), ("pPolicyCallbackData", ctypes.c_void_p),
                ("pSIPClientData", ctypes.c_void_p), ("dwUIChoice", wintypes.DWORD),
                ("fdwRevocationChecks", wintypes.DWORD), ("dwUnionChoice", wintypes.DWORD),
                ("choice", _WinTrustChoice), ("dwStateAction", wintypes.DWORD),
                ("hWVTStateData", wintypes.HANDLE), ("pwszURLReference", wintypes.LPWSTR),
                ("dwProvFlags", wintypes.DWORD), ("dwUIContext", wintypes.DWORD),
                ("pSignatureSettings", ctypes.c_void_p)]


class _ProviderCertPrefix(ctypes.Structure):
    """只读取官方 CRYPT_PROVIDER_CERT 的 cbStruct 与 pCert 前缀。"""

    _fields_ = [("cbStruct", wintypes.DWORD), ("pCert", ctypes.c_void_p)]


class _CertificateContext(ctypes.Structure):
    _fields_ = [("dwCertEncodingType", wintypes.DWORD),
                ("pbCertEncoded", ctypes.POINTER(wintypes.BYTE)),
                ("cbCertEncoded", wintypes.DWORD), ("pCertInfo", ctypes.c_void_p),
                ("hCertStore", wintypes.HANDLE)]


def _runtime_paths() -> tuple[str, str] | None:
    rows = desktop_ipc._processes()
    desktops = [row for row in rows if row.get("name", "").casefold() == "chatgpt.exe"]
    pairs = []
    for desktop in desktops:
        if (type(desktop.get("pid")) is not int or desktop["pid"] <= 0
                or type(desktop.get("creation")) is not int or desktop["creation"] <= 0
                or not isinstance(desktop.get("exe"), str) or not desktop["exe"]):
            continue
        children = [row for row in rows if row.get("name", "").casefold() == "codex.exe"
                    and row.get("parentPid") == desktop["pid"]]
        if len(children) != 1:
            continue
        child = children[0]
        if (type(child.get("pid")) is not int or child["pid"] <= 0
                or type(child.get("creation")) is not int or child["creation"] <= 0
                or not isinstance(child.get("exe"), str) or not child["exe"]):
            continue
        pairs.append((desktop["exe"], child["exe"]))
    if len(pairs) != 1:
        return None
    return pairs[0]


def _normalize_publisher(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = " ".join("".join(char if char.isprintable() else " " for char in value).split())
    return value[:_MAX_PUBLISHER_CHARS]


def _publisher_from_state(wintrust: ctypes.WinDLL, crypt32: ctypes.WinDLL, state: int) -> dict[str, str] | None:
    get_provider_data = wintrust.WTHelperProvDataFromStateData
    get_provider_data.argtypes = [wintypes.HANDLE]
    get_provider_data.restype = ctypes.c_void_p
    get_signer = wintrust.WTHelperGetProvSignerFromChain
    get_signer.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    get_signer.restype = ctypes.c_void_p
    get_cert = wintrust.WTHelperGetProvCertFromChain
    get_cert.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    get_cert.restype = ctypes.c_void_p

    provider_data = get_provider_data(state)
    signer = get_signer(provider_data, 0, False, 0) if provider_data else None
    provider_cert = get_cert(signer, 0) if signer else None
    if not provider_cert:
        return None
    cert_prefix = ctypes.cast(provider_cert, ctypes.POINTER(_ProviderCertPrefix)).contents
    if cert_prefix.cbStruct < ctypes.sizeof(_ProviderCertPrefix) or not cert_prefix.pCert:
        return None
    certificate = ctypes.cast(cert_prefix.pCert, ctypes.POINTER(_CertificateContext)).contents
    if (not certificate.pbCertEncoded or not 0 < certificate.cbCertEncoded <= _MAX_CERTIFICATE_BYTES):
        return None

    get_name = crypt32.CertGetNameStringW
    get_name.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                         wintypes.LPWSTR, wintypes.DWORD]
    get_name.restype = wintypes.DWORD
    required = int(get_name(cert_prefix.pCert, 4, 0, None, None, 0))  # CERT_NAME_SIMPLE_DISPLAY_TYPE
    if not 1 < required <= _MAX_NAME_CHARS:
        return None
    buffer = ctypes.create_unicode_buffer(required)
    written = int(get_name(cert_prefix.pCert, 4, 0, None, buffer, required))
    if not 1 < written <= required:
        return None
    subject = _normalize_publisher(buffer.value)
    if not subject:
        return None
    encoded = ctypes.string_at(certificate.pbCertEncoded, certificate.cbCertEncoded)
    return {"subject": subject, "certificateSha256": hashlib.sha256(encoded).hexdigest()}


def _verify_file(path: str) -> dict[str, object]:
    if os.name != "nt":
        return {"status": "unavailable", "reason": "windows_only", "publisherIdentity": None,
                "revocationCheck": "not_requested_cache_only"}
    try:
        wintrust = ctypes.WinDLL("wintrust", use_last_error=True)
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        verify = wintrust.WinVerifyTrust
        verify.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Guid), ctypes.c_void_p]
        verify.restype = ctypes.c_long

        action = _Guid(*_VERIFY_V2)
        file_info = _WinTrustFileInfo(ctypes.sizeof(_WinTrustFileInfo), path, None, None)
        data = _WinTrustData()
        data.cbStruct = ctypes.sizeof(_WinTrustData)
        data.dwUIChoice = 2  # WTD_UI_NONE
        data.fdwRevocationChecks = 0  # WTD_REVOKE_NONE
        data.dwUnionChoice = 1  # WTD_CHOICE_FILE
        data.choice.pFile = ctypes.pointer(file_info)
        data.dwStateAction = 1  # WTD_STATEACTION_VERIFY
        data.dwProvFlags = 0x1000  # WTD_CACHE_ONLY_URL_RETRIEVAL：仅用本地缓存

        try:
            raw_status = int(verify(ctypes.c_void_p(-1), ctypes.byref(action), ctypes.byref(data)))
        except Exception:
            return {"status": "unavailable", "reason": "winverifytrust_call_failed", "publisherIdentity": None,
                    "revocationCheck": "not_requested_cache_only"}

        code = raw_status & 0xFFFFFFFF
        status = "valid" if code == 0 else ("invalid" if code in _INVALID_TRUST_REASONS else "unavailable")
        reason = _INVALID_TRUST_REASONS.get(code)
        if code in _UNAVAILABLE_TRUST_CODES:
            reason = "trust_evidence_unavailable"
        elif code and reason is None:
            reason = "trust_status_unrecognized"
        publisher_identity = None
        if data.hWVTStateData:
            try:
                publisher_identity = _publisher_from_state(wintrust, crypt32, data.hWVTStateData)
            except Exception:
                publisher_identity = None
        if status == "valid" and publisher_identity is None:
            status = "unavailable"
            reason = "publisher_unavailable"
        result: dict[str, object] = {"status": status, "publisherIdentity": publisher_identity,
                                     "revocationCheck": "not_requested_cache_only"}
        if reason:
            result["reason"] = reason
        return result
    except Exception:
        return {"status": "unavailable", "reason": "native_api_unavailable", "publisherIdentity": None,
                "revocationCheck": "not_requested_cache_only"}
    finally:
        try:
            if "data" in locals() and data.hWVTStateData:
                data.dwStateAction = 2  # WTD_STATEACTION_CLOSE
                verify(ctypes.c_void_p(-1), ctypes.byref(action), ctypes.byref(data))
        except Exception:
            pass


def main() -> int:
    try:
        paths = _runtime_paths()
    except Exception:
        paths = None
    if paths is None:
        for target in ("ChatGPT.exe", "codex.exe"):
            print(json.dumps({"target": target, "status": "unavailable", "reason": "unique_process_pair_unavailable",
                              "publisherIdentity": None, "revocationCheck": "not_requested_cache_only"}, ensure_ascii=False,
                             separators=(",", ":")))
        return 0
    for target, path in zip(("ChatGPT.exe", "codex.exe"), paths):
        print(json.dumps({"target": target, **_verify_file(path)}, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
