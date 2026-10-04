import Cocoa
import WebKit
final class P: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var phase = "boot"; let wv: WKWebView; var win: NSWindow?
  override init() {
    let cfg = WKWebViewConfiguration(); cfg.userContentController = WKUserContentController()
    wv = WKWebView(frame: NSRect(x:0,y:0,width:900,height:600), configuration: cfg)
    super.init(); cfg.userContentController.add(self, name:"probe"); wv.navigationDelegate = self
    let w = NSWindow(contentRect: NSRect(x:0,y:0,width:900,height:600), styleMask:[.titled], backing:.buffered, defer:false)
    w.contentView = wv; win = w
  }
  func userContentController(_ u: WKUserContentController, didReceive msg: WKScriptMessage) {
    let d = msg.body as? [String:Any] ?? [:]
    print("IFRAME-EVENT phase=\(phase) tag=\(d["tag"] ?? "?") matches=\(d["matches"] ?? "?")")
  }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) { print("LOADED phase=\(phase)") }
}
let app = NSApplication.shared
let p = P()
p.wv.load(URLRequest(url: URL(string:"http://127.0.0.1:8777/parent_plain.html")!))
let seq: [(Double,String,NSAppearance.Name?)] = [(1.2,"pin-dark",.darkAqua),(2.5,"unpin",nil),(4.0,"pin-dark-again",.darkAqua),(5.5,"unpin-2",nil)]
for (t,label,a) in seq { DispatchQueue.main.asyncAfter(deadline:.now()+t) { p.phase=label; app.appearance = a.map{NSAppearance(named:$0)!} } }
DispatchQueue.main.asyncAfter(deadline:.now()+7){ print("DONE"); NSApp.terminate(nil) }
app.run()
