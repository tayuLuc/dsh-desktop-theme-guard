# dsh-desktop-theme-guard

**Status: created, NOT wired in.** Nothing references this directory from the profile — it is
absent from `$DSH_HOME/profiles/web/package.json` (`dependencies`, `dsh.profile.bundles`) and from
`cordis.patch.yml`. Enabling is a deliberate step (see below).

**TL;DR (RU):** в Desktop-приложении DSH пункт Appearance → *System* не следует за темой macOS,
потому что оболочка припинивает нативную внешность окна по `ui-theme.preference` из
`$DSH_HOME/settings.yaml`, а WKWebView берёт `prefers-color-scheme` именно из этой внешности.
Ключевая асимметрия: отсутствие ключа dsh читает как `system`, а оболочка — как `dark`.
Плагин (а) явно дописывает `preference` в settings.yaml, чтобы оболочка перестала пинить, и
(б) подаёт клиенту настоящую тему ОС пробой на хосте. По умолчанию включены обе половины.

---

## Symptom

`Settings → Appearance → System` follows the OS in a browser tab on `http://127.0.0.1:3080`, and
does nothing inside DeepSeek Harness Desktop: the theme stays put and flipping the macOS
appearance changes neither the content nor the window chrome.

## Root cause (measured, not inferred)

1. **The page resolves `system` from a media query.**
   `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1256,1378`
   ```js
   this.media = matchMedia('(prefers-color-scheme: dark)');
   const resolvedId = this.preference === 'system'
     ? (this.media?.matches === true ? 'dark' : 'light') : this.preference;
   ```
   Re-resolution happens only on that MediaQueryList's `change` event.

2. **The desktop app pins the native appearance from a text file.**
   `github.com/dsh-tauri-desk/deepseek-harness-desktop`, installed 0.11.0 (checked at tag v0.11.0):
   ```
   src-tauri/src/desktop/builder.rs:395   .theme(match get_dsh_theme(app) { System => None, Light => Some(Light), Dark => Some(Dark) })
   src-tauri/src/config/theme.rs:18       const DEFAULT_THEME: DshTheme = DshTheme::Dark;   // missing key means "dark"
   src-tauri/src/config/theme.rs:23-33    get_dsh_theme() = ui-theme.preference from $DSH_HOME/settings.yaml, else DEFAULT_THEME
   src-tauri/src/config/theme.rs:76-89    apply_window_theme() → window.set_theme(…)   // polled every 5 s: service/scheduler/mod.rs:22
   ```
   tao (`tao-0.35.3/src/platform_impl/macos/window.rs:384`) implements that as
   `[NSApplication.sharedApplication setAppearance: darkAqua | aqua | nil]` — app-wide, not
   per-window. The pin is deliberate (upstream issue #93: content light, titlebar dark).

3. **In WKWebView `prefers-color-scheme` *is* the native appearance.** Measured on macOS 26.6 with
   the OS set to Light, standalone WKWebView harness with an iframe (the app embeds dsh in one):

   | `NSApp.appearance` | `matchMedia('(prefers-color-scheme: dark)').matches` |
   | --- | --- |
   | `nil` (follow system) | `false` — truthful |
   | `NSAppearanceNameDarkAqua` | **`true` — reports the pin, not the OS** |
   | `NSAppearanceNameAqua` | `false` |
   | back to `nil` | `false`, with a `change` event |

   While the pin is on, the page cannot see the OS theme at all, and OS flips cannot reach it.

4. **The two defaults disagree, and absence is the normal state.** dsh's default preference is
   `system` and it persists only deviations, so an untouched profile has **no `ui-theme:` section
   at all** (verified in the the harness `$DSH_HOME` git history: the section first appeared when an explicit
   `light` was picked; `preference: system` was never written). The desktop app reads that absence
   as **Dark** and pins the whole app dark. A default install therefore cannot follow the system
   theme, while the same build in a browser can.

5. **The page cannot work around it alone.** The dsh UI runs in an iframe on another origin
   (`tauri://localhost` embedding `http://127.0.0.1:3080`), `__TAURI_INTERNALS__` is not exposed
   there (that is why `dsh-tauri` relays commands through `window.parent.postMessage`), and the
   relay allowlist (`src/hooks/use-iframe-invoke.ts`) carries pet commands only. There is no
   in-page source of the OS theme that the pin cannot forge.

## Fix

Two halves, independently switchable, both on by default:

1. **`materializePreference` (host).** When the document omits `ui-theme.preference`, write the
   live resolved value explicitly. The shell then sees `system`, calls `set_theme(None)`, stops
   pinning — and the **native titlebar follows the OS too**, which no page-side patch can do.
   This alone is sufficient when the OS→webview propagation works (it does; see `change` in the
   table above). Set `materializePreference: false` to leave settings.yaml untouched.

2. **Probe + sensor shadow (host + client).** Host serves
   `GET /desktop-theme-guard/os` → `{"dark":true|false|null,"source":"macos","at":…,"ttlMs":…}`,
   probing the OS directly: `defaults read -g AppleInterfaceStyle` (exit 1 = light), `reg query …
   AppsUseLightTheme`, `gsettings get org.gnome.desktop.interface color-scheme`. One spawn per TTL
   window (1.5 s; a `null` answer is cached 4× longer), never throwing.

   The client shadows the `matches` accessor **on the very MediaQueryList the theme service holds**
   (`ctx.theme.media`) and dispatches `change` on it whenever the probe flips.
   `ThemeRuntime.buildSnapshot()` then resolves `system` from the truth and its own listener
   republishes — no private call, no service replacement, no stylesheet surgery. Verified in real
   WebKit: own-property shadowing of `matches` works, a synthetic `change` reaches listeners
   registered via `addEventListener`, and `delete` restores the native reading.

This half covers what materialization cannot: a user who genuinely keeps `light`/`dark` (pin by
design) and then moves back to `system`, the window between clicking `system` and the shell's next
5 s poll, and any future app that pins harder.

Safety and failure behaviour (all covered by `test/client-harness.mjs`, 44 assertions):

* inert in a plain browser — gated on the desktop app's own all-frames init markers
  (`__dsh_nav_bridge__`, `__dsh_iframe_styles__`, `__dsh_clipboard_image_bridge__`,
  `__dsh_plugin_boot_reload__`); the UA token is only a speculative extra;
* installs nothing unless the sensor is the real `prefers-color-scheme` MediaQueryList the
  theme service listens on, and reverts (with one warning) if the service ever swaps it out —
  driving a stale sensor would be a private fiction with no reader;
* **install generations live on `window`**: a bundle reload that skipped teardown makes the older
  closure stand down on its next poll, and it will not delete a shadow it no longer owns;
* **`404/405` reverts only after three in a row** — a restarting host or a not-yet-registered
  route must not cost the theme for the whole session; in the meantime the poll backs off to 30 s.
  Transient failures (connection refused, 5xx, `dark: null`) never revert at all, they only back
  off and recover;
* the first honest measurement applies at once (it corrects the pinned reading, and an agreeing
  first answer counts as that measurement); every later flip must be confirmed by a second
  identical reading, so a probe that answers mid-transition cannot repaint
  the app twice;
* a request that never settles cannot stall the loop (the next poll is armed before the fetch is
  awaited, overlapping polls are skipped, and `AbortSignal.timeout` bounds the request where
  WebKit supports it (where it does not, the pre-await re-arm keeps the loop alive anyway)); no
  polling at all while the document is hidden — the reveal issues the next probe;
* the synthetic `change` is a real `MediaQueryListEvent` when the constructor exists, so a
  subscriber that reads `event.matches` (the spec'd shape) sees the new value;
* `light`/`dark` preferences are never overridden — the pin already matches the user's choice;
* effect-scoped: the shadow, the timer, and the visibility listener are all removed on dispose,
  and a second `apply()` on the same sensor is a no-op (symbol guard).

Host side: the probe spawns at most one process per TTL window (`execFile` with a 2 s timeout,
64 KB buffer, ENOENT distinguished from "key absent"), the answer is cached and shared between
concurrent waiters, the route answers `GET/HEAD` only, only over loopback, and refuses an explicit
`Sec-Fetch-Site: cross-site`. The settings write is idempotent (only an absent key is written), is
carried with the revision it was read at (a concurrent UI write wins and is retried on the next
event), and the materialization retries at 1.5 s / 5 s / 20 s in case another plugin registers the
`ui-theme` namespace late.

**No CORS headers are sent on purpose.** The client runs in the dsh document itself
(`http://127.0.0.1:3080`), so its probe is a same-origin request; `tauri://localhost` never fetches
this route. Leaving `Access-Control-Allow-Origin` off means a foreign page that reaches the port
learns nothing, which is the point of the loopback check.

## Config

On the profile bundle row (see `cordis.patch.yml`):

```yaml
config:
  path: /desktop-theme-guard/os   # host route; client default matches
  ttlMs: 1500                     # host probe cache
  pollMs: 3000                    # client poll interval (>=500)
  probe: true                     # serve / perform the OS probe
  materializePreference: true     # write ui-theme.preference when absent
  enabled: true                   # false = client half installs nothing (host route still served)
```

## Security note

`GET /desktop-theme-guard/os` is an unauthenticated exact route, like other plugin routes
(`webhook-github` is the precedent). It exposes one boolean about the machine's appearance. The
harness binds `127.0.0.1` by default and the packaged build refuses `--host 0.0.0.0` unless
`DSH_PKG_ALLOW_LAN=1`, so it is loopback-only in practice. Set `probe: false` if even that is too
much; the materialization half keeps working (it needs no route) — though in that case a browser
tab keeps its native, already-correct behaviour while the desktop app needs `materializePreference`
to un-stick the pin.

## Enable / verify / roll back

`dsh plugin` is a pnpm forwarder that **also reconciles the bundle roster**: after a successful
install it appends every newly installed package that declares `dsh.bundle.patch` to
`dsh.profile.bundles`, and prunes it on removal. One command is therefore the supported way — no
manual `package.json` surgery. This is also what the desktop app's own installer does
(`src-tauri/src/service/plugin/install/mod.rs`; disable/enable are `bundles` row edits,
`src-tauri/src/bridge/plugin.rs`).

```bash
dsh plugin --profile web add <path-to-this-repo>
# then restart the harness process (the app's own restart action, or kill the
# `bin.js --profile web` process — the supervisor respawns it in ~15-20 s)
```

`link:` rather than `file:` keeps the profile pointed at this directory, so an edit needs only a
restart instead of a reinstall (same form the app uses for its bundled plugins). pnpm on `PATH`
must be ≥ 11 — this machine has `~/.local/bin/pnpm` 11.7.0, matching the store the profile was
built with; a pnpm 10 on PATH fails with `ERR_PNPM_UNEXPECTED_STORE`.

Fallback if the CLI is inconvenient — the manual equivalent of the reconcile step:

```bash
cp -R $DSH_HOME/plugins/dsh-desktop-theme-guard $DSH_HOME/profiles/web/plugins/
# $DSH_HOME/profiles/web/package.json: add BOTH
#   "dependencies": { "dsh-desktop-theme-guard": "file:plugins/dsh-desktop-theme-guard" }
#   "dsh": { "profile": { "bundles": [ … , "dsh-desktop-theme-guard" ] } }
"<AppSupport>/io.github.hairyf.deepseek-harness-desktop/dependencies/pnpm/bin/pnpm.cjs" \
  install --dir $DSH_HOME/profiles/web   # pnpm that owns the store
```

Disable without uninstalling: drop the name from `dsh.profile.bundles` (exactly what the app's
disable action does; the package stays installed, `node_modules` untouched).

Verify:

```bash
curl -s localhost:3080/desktop-theme-guard/os        # must agree with the OS appearance
defaults read -g AppleInterfaceStyle                 # "Dark", or the key absent = Light
grep -A1 '^ui-theme:' $DSH_HOME/settings.yaml           # preference now written explicitly
```

Then flip the macOS appearance and watch the app follow within ~3 s.

Roll back: `dsh plugin --profile web remove dsh-desktop-theme-guard` (prunes the bundles row too),
restart. With `materializePreference` on, `settings.yaml` keeps the written `preference:` line —
delete it by hand to get the file back exactly as it was.

## Known trade-off

With `materializePreference: true`, deleting `ui-theme.preference` from settings.yaml by hand no
longer means "let the app default to Dark" — the plugin writes the live value back (that is the
whole point: absence is what breaks the desktop). If you want the pinned-Dark behaviour, choose
*Dark* in the UI instead of removing the key, or set `materializePreference: false`.

## Not covered

* **First paint.** The server-rendered boot script
  (`dsh-client-ui-theme/lib/index.js:57-95`, `bootThemeScript`) sets `color-scheme` and
  `data-ds-dark-theme` inline from the same pinned media query, before any plugin runs. With
  `materializePreference: true` this disappears too (the pin is gone); probe-only mode leaves a
  brief flash on reload.
* The proper upstream fix is one line in the app: `DEFAULT_THEME = System`, or "no key → do not
  pin". Then this plugin is redundant. It is deliberately built so that deleting it is one edit.

## Layout

```
package.json        cordis plugin manifest (dsh.bundle.patch → cordis.patch.yml)
cordis.patch.yml    profile bundle patch: the plugin row
lib/index.js        host: OS probe route + settings materialization
lib/client.js       client: ModuleLoader bundle, MediaQueryList shadow + polling
```
