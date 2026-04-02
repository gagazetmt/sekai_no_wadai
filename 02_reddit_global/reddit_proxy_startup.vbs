' Windows起動時にRedditプロキシをバックグラウンドで自動起動する
' このファイルをスタートアップフォルダに置く
' スタートアップフォルダ: shell:startup
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c node C:\Users\USER\Documents\side_biz\02_reddit_global\reddit_proxy.js", 0, False
