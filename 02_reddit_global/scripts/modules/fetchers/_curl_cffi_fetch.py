#!/usr/bin/env python3
"""curl-cffi + Chrome131 TLS フィンガープリント汎用フェッチャー

Node 側の _curl_cffi_caller.js から subprocess で呼ばれる汎用版。
SofaScore / FotMob / Transfermarkt 全部対応。

旧 _sofa_fetch.py の機能拡張版:
  - 任意のヘッダ
  - 任意の URL (sofa/fotmob/tm 共通)
  - binary レスポンス対応 (画像)
  - リトライ機構

入力フォーマット (stdin):
  {
    "url": "https://...",
    "proxy": "http://user:pass@host:port",     # 任意
    "headers": {"Referer": "..."},             # 任意
    "timeout": 20,                             # 任意 (sec)
    "impersonate": "chrome131",                # 任意
    "binary": false,                           # 任意 (画像なら true)
    "retries": 2,                              # 任意 (3回目以降は別 IP 推奨)
  }

出力フォーマット (stdout):
  成功: {"ok": true, "status": 200, "body": "<text or base64>", "size": N, "binary": false|true}
  失敗: {"ok": false, "status": <int>, "error": "...", "body": "<head>"}
"""

import json
import sys
import time

try:
    from curl_cffi import requests
except ImportError:
    print(json.dumps({"ok": False, "error": "curl-cffi not installed. run: pip3 install curl-cffi --break-system-packages"}))
    sys.exit(0)


DEFAULT_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


def fetch_once(url, proxy, headers, timeout, impersonate, binary):
    kwargs = {
        "headers": headers,
        "timeout": timeout,
        "impersonate": impersonate,
    }
    if proxy:
        kwargs["proxy"] = proxy
    r = requests.get(url, **kwargs)
    if binary:
        import base64
        return {
            "ok": r.status_code == 200,
            "status": r.status_code,
            "body": base64.b64encode(r.content).decode("ascii"),
            "size": len(r.content),
            "binary": True,
            "content_type": r.headers.get("content-type", ""),
        }
    return {
        "ok": r.status_code == 200,
        "status": r.status_code,
        "body": r.text,
        "size": len(r.content),
        "binary": False,
        "content_type": r.headers.get("content-type", ""),
    }


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"stdin parse: {e}"}))
        return

    url = req.get("url")
    if not url:
        print(json.dumps({"ok": False, "error": "url required"}))
        return

    proxy = req.get("proxy")
    headers = {**DEFAULT_HEADERS, **(req.get("headers") or {})}
    timeout = req.get("timeout", 20)
    impersonate = req.get("impersonate", "chrome131")
    binary = bool(req.get("binary", False))
    retries = max(0, int(req.get("retries", 1)))

    last_err = None
    last_result = None
    for attempt in range(retries + 1):
        try:
            result = fetch_once(url, proxy, headers, timeout, impersonate, binary)
            # 2xx は確定成功
            if 200 <= result["status"] < 300:
                print(json.dumps(result, ensure_ascii=False))
                return
            # 403/429/5xx は再試行
            if result["status"] in (403, 429) or result["status"] >= 500:
                last_result = result
                if attempt < retries:
                    time.sleep(0.5 + attempt)  # 0.5s, 1.5s, ...
                    continue
            # その他のエラーは即返す
            print(json.dumps(result, ensure_ascii=False))
            return
        except Exception as e:
            last_err = str(e)[:300]
            if attempt < retries:
                time.sleep(0.5 + attempt)
                continue
    # リトライ尽きた
    if last_result:
        last_result["ok"] = False
        last_result["body"] = last_result.get("body", "")[:200] if not last_result.get("binary") else ""
        print(json.dumps(last_result, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": last_err or "unknown"}))


if __name__ == "__main__":
    main()
