#!/usr/bin/env python3
"""
SofaScore 用 HTTP フェッチャー（curl-cffi + Chrome TLS 指紋）

stdin から JSON リクエストを受け取り、stdout に JSON レスポンスを返す。
Node 側の _sofa_common.js から subprocess で呼ばれる。

入力フォーマット（stdin）:
  {"url": "...", "proxy": "...", "headers": {...}, "timeout": 20, "impersonate": "chrome131"}

出力フォーマット（stdout）:
  成功: {"ok": true, "status": 200, "body": "<<response text>>"}
  失敗: {"ok": false, "error": "..."}
"""

import json
import sys

try:
    from curl_cffi import requests
except ImportError:
    print(json.dumps({"ok": False, "error": "curl-cffi not installed. run: pip3 install curl-cffi --break-system-packages"}))
    sys.exit(0)


DEFAULT_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.sofascore.com/",
    "Origin":  "https://www.sofascore.com",
}


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"stdin parse: {e}"}))
        return

    url         = req.get("url")
    proxy       = req.get("proxy")  # 単数形。curl-cffi の使い方
    headers     = {**DEFAULT_HEADERS, **(req.get("headers") or {})}
    timeout     = req.get("timeout", 20)
    impersonate = req.get("impersonate", "chrome131")

    if not url:
        print(json.dumps({"ok": False, "error": "url required"}))
        return

    kwargs = {
        "headers":     headers,
        "timeout":     timeout,
        "impersonate": impersonate,
    }
    if proxy:
        kwargs["proxy"] = proxy

    try:
        r = requests.get(url, **kwargs)
        print(json.dumps({
            "ok":     True,
            "status": r.status_code,
            "body":   r.text,
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))


if __name__ == "__main__":
    main()
