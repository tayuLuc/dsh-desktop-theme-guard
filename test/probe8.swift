import Cocoa
import WebKit
final class P: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let wv: WKWebView; var win: NSWindow?
  override init() {
    let cfg = WKWebViewConfiguration(); cfg.userContentController = WKUserContentController()
    wv = WKWebView(frame: NSRect(x:0,y:0,width:900,height:600), configuration: cfg)
    super.init(); cfg.userContentController.add(self, name:"probe"); wv.navigationDelegate = self
    let w = NSWindow(contentRect: NSRect(x:0,y:0,width:900,height:600), styleMask:[.titled], backing:.buffered, defer:false)
    w.contentView = wv; win = w
  }
  func userContentController(_ u: WKUserContentController, didReceive msg: WKScriptMessage) {
    print("PROBE \(msg.body)")
  }
}
let app = NSApplication.shared
let p = P()
let html = try! String(contentsOfFile: "/tmp/themetest/web/parent_local.html", encoding: .utf8)
p.wv.loadHTMLString(html, baseURL: URL(fileURLWithPath: "/tmp/themetest/web/parent_local.html"))
DispatchQueue.main.asyncAfter(deadline: .now() + 4) { NSApp.terminate(nil) }
app.run()
