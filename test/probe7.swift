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
    let d = msg.body as? [String:Any] ?? [:]
    print("PROBE app=\(NSApp.effectiveAppearance.name.rawValue) \(d["matches"] ?? "?")")
  }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {}
}
let app = NSApplication.shared
let pin = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if !pin.isEmpty { app.appearance = NSAppearance(named: pin == "dark" ? .darkAqua : .aqua) }
let p = P()
p.wv.load(URLRequest(url: URL(string: "http://127.0.0.1:8777/shadow.html")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.terminate(nil) }
app.run()
