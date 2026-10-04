# Verification artifacts

Run the client state machine (no browser needed, Node 22):

    node test/client-harness.mjs           # 44 assertions, all expected PASS

Reproduce the WKWebView measurement (the claim that the app's appearance pin
overrides `prefers-color-scheme` inside an iframe, and that shadowing `matches`
plus a synthetic `change` event works in real WebKit):

    cd test && python3 -m http.server 8777 --directory web &
    swiftc -O probe5.swift -o probe && ./probe          # pin -> change -> unpin
    swiftc -O probe7.swift -o probe7 && ./probe7 dark   # shadow/dispatch/delete in an iframe

`probe8.swift` (built into the same `Probe.app`) answers the CORS question: it loads a `file:`
parent that embeds a `http://127.0.0.1:8777` document which does a **relative** `fetch('/os.json')`
against a server that sends no `Access-Control-Allow-Origin`. Observed: `status 200`, body parsed,
`acao: null` — a relative fetch inside the embedded document is same-origin no matter who embeds it,
so the plugin route needs no CORS headers (and must not get them).

    cd test && python3 -m http.server 8777 --directory web &
    swiftc -O probe8.swift -o Probe.app/Contents/MacOS/Probe   # rebuild the app binary first
    ./Probe.app/Contents/MacOS/Probe

`probe5` prints `IFRAME-EVENT … matches=…` per appearance transition; `probe7`
prints native/shadowed/restored readings. Both need a bundled app binary
(`.app/Contents/MacOS/…`) for `NSApp.effectiveAppearance` to follow the OS.
