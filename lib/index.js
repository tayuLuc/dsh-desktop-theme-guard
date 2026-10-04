// dsh-desktop-theme-guard — host (Node) half.
//
// WHY THIS PLUGIN EXISTS (verified 2026-09-09)
//
// DSH resolves the `system` appearance preference from inside the page:
//   dsh-client-ui-theme/lib/client.js:1256  this.media = matchMedia('(prefers-color-scheme: dark)')
//   dsh-client-ui-theme/lib/client.js:1378  preference === 'system' ? (this.media?.matches ? 'dark' : 'light')
// In a browser that media query is the OS theme, so "System" follows the OS.
//
// The DeepSeek Harness Desktop app (Tauri + wry/WKWebView) pins the native
// appearance of its window from `ui-theme.preference` parsed out of
// ~/.dsh/settings.yaml:
//   src-tauri/src/desktop/builder.rs:395   .theme(match get_dsh_theme(app) { System => None, Light => Some, Dark => Some })
//   src-tauri/src/config/theme.rs:76-89    apply_window_theme() -> window.set_theme(...)
//   src-tauri/src/config/theme.rs:18       DEFAULT_THEME = Dark  (used when the key is absent/unparsable)
//   tao set_ns_theme()                     [NSApp setAppearance: darkAqua | aqua | nil]
//
// WKWebView derives `prefers-color-scheme` from that NSApplication appearance.
// Measured with a standalone WKWebView harness on macOS 26.6 with the OS set to
// Light:
//   app.appearance = nil        -> matchMedia('(prefers-color-scheme: dark)').matches === 0
//   app.appearance = DarkAqua   -> matches === 1, and a `change` event fires
//   app.appearance = Aqua       -> matches === 0
// So while the desktop app pins the appearance, the page's media query reports
// the PIN, not the OS: `system` can never follow the OS in the desktop app, and
// OS theme flips never reach it. That is the whole difference from the browser.
//
// WHAT THIS PLUGIN DOES
//   1. Serves `GET /desktop-theme-guard/os` with the REAL OS appearance, probed
//      out of band (`defaults` / registry / gsettings). It is the one signal the
//      pin cannot forge, and the client half drives the theme service from it.
//   2. Materializes `ui-theme.preference` in the user settings document when the
//      document omits it. dsh means "system" by absence; the desktop app means
//      "dark" by absence, and pins the whole app dark for a user who never chose
//      anything. Writing the live value explicitly ends that disagreement — and
//      also un-sticks the native titlebar, which no page-side patch can reach.
//
// The two duties are independent and individually switchable (see README).

import { execFile } from 'node:child_process';

const name = 'dsh-desktop-theme-guard';
/**
 * `webServer` for the probe route; `settings` for the materializer. Declared
 * rather than probed through `ctx.get` so the framework orders this fiber after
 * both providers instead of letting them silently miss the startup window.
 */
const inject = ['webServer', 'settings'];

const DEFAULT_PATH = '/desktop-theme-guard/os';
const DEFAULT_TTL_MS = 1500;
/** Namespace registered by dsh-client-ui-theme's host half. */
const THEME_NAMESPACE = 'ui-theme';
const THEME_PREFERENCE_FIELD = 'preference';
const THEME_PREFERENCES = ['light', 'dark', 'system'];
/**
 * The `ui-theme` namespace is registered by another plugin, so the first pass is
 * delayed; the ladder covers a slow boot without assuming a duration.
 */
const MATERIALIZE_RETRIES_MS = [1500, 5000, 20000];

/** Probe cache: one spawn per TTL window, shared by every concurrent waiter. */
const cache = { at: 0, dark: null, source: 'none', detail: '', pending: null };
/** Report a probe that cannot answer once per process, not on every poll. */
let warnedNoAnswer = false;

/**
 * Run one short-lived CLI probe.
 *
 * A non-zero exit is data, not only a failure: `defaults` exits 1 exactly when
 * the key is absent, which is the light-mode answer.
 * @returns `{ exitCode, unavailable, text, stderr }`, or null when the tool cannot run at all.
 */
function spawnText(command, args, timeout = 2000) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child;
		try {
			child = execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
				done({
					exitCode: typeof error?.code === 'number' ? error.code : 0,
					// ENOENT / EPERM / EACCES: the probe tool itself is unavailable.
					unavailable: typeof error?.code === 'string',
					text: String(stdout ?? '').trim(),
					stderr: String(stderr ?? '').trim().slice(0, 160),
				});
			});
		} catch {
			done(null);
			return;
		}
		if (child?.on !== undefined) child.on('error', () => done(null));
	});
}

/**
 * Read the real OS appearance without going through the webview.
 * @returns `{ dark: boolean | null, source: string, detail: string }`; null means "no answer".
 */
async function probeSystemAppearance() {
	if (process.platform === 'darwin') {
		// `defaults read -g AppleInterfaceStyle` prints "Dark" in dark mode and
		// exits 1 with no output when the key is absent, i.e. light mode.
		const result = await spawnText('defaults', ['read', '-g', 'AppleInterfaceStyle']);
		if (result === null) return { dark: null, source: 'macos', detail: 'defaults could not be spawned' };
		if (result.unavailable) return { dark: null, source: 'macos', detail: result.stderr || 'defaults unavailable' };
		if (result.text.toLowerCase().includes('dark')) return { dark: true, source: 'macos', detail: '' };
		if (result.exitCode === 1) return { dark: false, source: 'macos', detail: '' };
		return { dark: null, source: 'macos', detail: result.stderr || `defaults exited ${result.exitCode}` };
	}
	if (process.platform === 'win32') {
		const result = await spawnText('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme']);
		const found = result?.text.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
		if (found === null || found === undefined) return { dark: null, source: 'windows', detail: result?.stderr || 'no AppsUseLightTheme value' };
		return { dark: Number.parseInt(found[1], 16) === 0, source: 'windows', detail: '' };
	}
	// GNOME/KDE expose the setting unquoted-in-earnest but single-quoted on stdout.
	const result = await spawnText('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
	// gsettings prints the value single-quoted: `'prefer-dark'`.
	const text = (result?.text ?? '').replaceAll("'", '').toLowerCase();
	if (text.includes('dark')) return { dark: true, source: 'linux', detail: '' };
	if (text.includes('light') || text.includes('default')) return { dark: false, source: 'linux', detail: '' };
	return { dark: null, source: 'linux', detail: result?.stderr || 'no gsettings color-scheme' };
}

/**
 * Cached probe so a chatty client cannot spawn a process per request. An
 * "unknown" answer is held four times as long: re-spawning a probe that cannot
 * answer is pure overhead, and the client half gives up on its own.
 */
async function cachedAppearance(ttlMs, logger) {
	const window = cache.dark === null ? ttlMs * 4 : ttlMs;
	if (Date.now() - cache.at < window) return cache;
	if (cache.pending !== null) return cache.pending;
	const settle = (probed) => {
		cache.at = Date.now();
		cache.dark = probed?.dark ?? null;
		cache.source = probed?.source ?? 'error';
		cache.detail = probed?.detail ?? 'probe threw';
		cache.pending = null;
		if (cache.dark === null && warnedNoAnswer === false) {
			warnedNoAnswer = true;
			logger?.warn?.('%s: appearance probe has no answer (%s: %s)', name, cache.source, cache.detail);
		}
		return cache;
	};
	cache.pending = probeSystemAppearance().then(settle, () => settle(null));
	return cache.pending;
}

/**
 * Materialize the preference the desktop shell reads.
 *
 * dsh treats "no stored preference" as `system`; the desktop app treats the same
 * absence as `dark` and pins the native appearance, which then lies to every
 * media query in the embedded page. Persisting the live value explicitly removes
 * the disagreement at the source.
 *
 * Only the absent case is written: a document that already states a preference
 * is the user's, and the optimistic-concurrency revision keeps a simultaneous UI
 * write from being overwritten by us.
 */
async function materializeThemePreference(ctx) {
	const settings = ctx.get('settings');
	if (typeof settings?.describe !== 'function' || typeof settings.update !== 'function') return false;
	let descriptor;
	try {
		descriptor = settings.describe({ redactSecrets: true }).find((item) => item.ns === THEME_NAMESPACE);
	} catch {
		return false;
	}
	// Namespace not composed in this profile (yet): worth another pass later.
	if (descriptor === void 0) return false;
	const wanted = descriptor.value?.[THEME_PREFERENCE_FIELD];
	if (!THEME_PREFERENCES.includes(wanted)) return true;
	if (descriptor.user?.[THEME_PREFERENCE_FIELD] === wanted) return true;
	try {
		await settings.update(THEME_NAMESPACE, { [THEME_PREFERENCE_FIELD]: wanted }, descriptor.revision);
		ctx.logger?.info?.('%s: wrote %s.%s = %s so the desktop shell stops pinning', name, THEME_NAMESPACE, THEME_PREFERENCE_FIELD, wanted);
	} catch (error) {
		// A concurrent write won: the next retry or document event re-evaluates.
		if (error?.code === 'SETTINGS_CONFLICT') return true;
		ctx.logger?.warn?.('%s: cannot materialize %s.%s (%s)', name, THEME_NAMESPACE, THEME_PREFERENCE_FIELD, error?.message ?? error);
	}
	return true;
}

/**
 * Whether the request reached us over loopback (this route has no auth).
 *
 * Assumes the client connects to the harness server directly, which is how the desktop app embeds
 * it (`http://127.0.0.1:<port>`) and how the server binds by default. Behind a reverse proxy the
 * peer address is the proxy's, so this check would answer 403 for everyone: if such a deployment
 * is ever introduced, replace it with the proxy's forwarded address or drop `probe` there.
 */
function isLoopback(req) {
	const address = req?.socket?.remoteAddress ?? '';
	return address.startsWith('127.') || address === '::1' || address === '::ffff:127.0.0.1';
}

function apply(ctx, config = {}) {
	const options = {
		path: typeof config.path === 'string' && config.path.startsWith('/') ? config.path : DEFAULT_PATH,
		ttlMs: Number.isFinite(config.ttlMs) && config.ttlMs >= 250 ? config.ttlMs : DEFAULT_TTL_MS,
		probe: config.probe !== false,
		materializePreference: config.materializePreference !== false,
	};

	if (options.probe) {
		const route = {
			kind: 'exact',
			path: options.path,
			async handler(req, res) {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405, { allow: 'GET, HEAD', 'content-length': '0' });
					res.end();
					return;
				}
				// No auth on this route (plugin routes are registered raw), so answer
				// loopback clients only and refuse an explicit cross-site fetch. The
				// legitimate caller is the dsh document itself: same-origin, no CORS
				// involved — deliberately no `access-control-allow-origin` header, so a
				// foreign page cannot read the answer even if it reaches the port.
				if (!isLoopback(req) || String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
					res.writeHead(403, { 'content-length': '0' });
					res.end();
					return;
				}
				const entry = await cachedAppearance(options.ttlMs, ctx.logger);
				const body = JSON.stringify({ dark: entry.dark, source: entry.source, at: entry.at, ttlMs: options.ttlMs });
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
					'content-length': Buffer.byteLength(body),
				});
				res.end(req.method === 'HEAD' ? void 0 : body);
			},
		};
		// `register` returns the disposer, which is what an effect body must hand
		// back so the route goes away with the plugin.
		ctx.effect(() => ctx.webServer.register(route), `${name}: os appearance probe`);
	}

	if (options.materializePreference) {
		ctx.effect(() => {
			const timers = [];
			let done = false;
			const kick = async () => {
				if (done) return;
				done = await materializeThemePreference(ctx);
				if (done) for (const timer of timers.splice(0)) clearTimeout(timer);
			};
			for (const delay of MATERIALIZE_RETRIES_MS) timers.push(setTimeout(() => void kick(), delay));
			// Any later change to the document re-opens the question: the key may have
			// been removed by hand, or the namespace may only now be composed.
			const off = ctx.on('settings/document-updated', (ns) => {
				if (ns !== THEME_NAMESPACE) return;
				done = false;
				void kick();
			});
			return () => {
				for (const timer of timers.splice(0)) clearTimeout(timer);
				off?.();
			};
		}, `${name}: explicit theme preference`);
	}
}

export { apply, inject, name };
