// dsh-desktop-theme-guard — client (browser) half, ModuleLoader format.
//
// What it fixes, precisely
//   The DSH theme service resolves the `system` preference from
//   matchMedia('(prefers-color-scheme: dark)'), captured once at construction
//   (dsh-client-ui-theme/lib/client.js:1256, resolved at :1378). Inside the
//   DeepSeek Harness Desktop app that media query is NOT the OS theme: the
//   shell pins the native appearance from `ui-theme.preference` in
//   ~/.dsh/settings.yaml (src-tauri/src/config/theme.rs -> tao set_ns_theme ->
//   [NSApp setAppearance:]), and WKWebView derives `prefers-color-scheme` from
//   that pin. A pinned appearance also silences the media-query `change` event,
//   so flipping the OS theme never reaches the page. In a browser there is no
//   pin, which is why "System" follows the OS there and not in the desktop app.
//
// How
//   The host half answers GET /desktop-theme-guard/os with the real OS
//   appearance read out of band (`defaults` / registry / gsettings) — the one
//   signal the pin cannot forge. Here we shadow the `matches` accessor on the
//   very MediaQueryList the theme service already holds (it listens for
//   `change` on that exact object, see dsh-client-ui-theme client.js:1258-1269),
//   so that
//     - ThemeRuntime.buildSnapshot() resolves `system` from the truth, and
//     - the service's own listener still fires: we dispatch `change` on that
//       object whenever the probe flips.
//   No private method is called and no stylesheet is touched — the plugin only
//   replaces the sensor the application was already reading. Verified in real
//   WebKit: the shadow takes, a synthetic `change` reaches listeners added via
//   addEventListener, and deleting the shadow restores the native reading.
//
// Gating: inert unless the desktop app's own all-frames init scripts are
// present, so a browser tab keeps its native, already-correct path. The request
// is same-origin (this document is the harness server's own page), so no CORS.

window.__ModuleLoader__.load({
	id: 'dsh-desktop-theme-guard',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const name = 'dsh-desktop-theme-guard';
		const inject = ['theme'];
		const PROBE_PATH = '/desktop-theme-guard/os';
		const POLL_MS = 3000;
		const MIN_POLL_MS = 500;
		/** Cadence once the probe keeps failing, so a dead host costs ~1 request per backoff. */
		const BACKOFF_MS = 30000;
		/** Consecutive transient failures before slowing down. */
		const FAILURE_BUDGET = 3;
		/** Consecutive "route is not here" answers before handing the sensor back (M1). */
		const MISS_BUDGET = 3;
		/** A change is applied only when seen this many times, to kill probe jitter. */
		const CONFIRMATIONS = 2;
		/** Bound every probe: a request that never settles must not pin the loop. */
		const PROBE_TIMEOUT_MS = 5000;
		/** Flags the desktop app injects into every frame of its webview. */
		const DESKTOP_MARKERS = ['__dsh_nav_bridge__', '__dsh_iframe_styles__', '__dsh_clipboard_image_bridge__', '__dsh_plugin_boot_reload__'];
		/** Which generation of this patch owns the sensor right now. */
		const OWNED = Symbol.for('dsh-desktop-theme-guard.owned');
		/**
		 * Install generation, kept on `window` so it survives a bundle reload that skipped
		 * teardown. A superseded closure stands down on its own next poll (M2), instead of
		 * going on as a zombie loop driving a sensor nobody reads.
		 */
		const GENERATION = Symbol.for('dsh-desktop-theme-guard.generation');

		/** True inside the Tauri desktop app's webview, false in a browser tab. */
		function isDesktopShell() {
			if (typeof window === 'undefined') return false;
			for (const marker of DESKTOP_MARKERS) if (window[marker] === true) return true;
			// Not a marker the app injects today; kept because the app's own HTTP
			// clients advertise it, so a future webview UA may carry it too.
			return typeof navigator?.userAgent === 'string' && navigator.userAgent.includes('deepseek-harness-desktop');
		}

		/** The sensor we can drive: a MediaQueryList for the color-scheme query. */
		function isColorSchemeSensor(candidate) {
			if (candidate === null || candidate === void 0) return false;
			if (typeof candidate.addEventListener !== 'function' || typeof candidate.dispatchEvent !== 'function') return false;
			// WebKit hands us a real MediaQueryList; a stub without `media` (or with
			// another query) is not the sensor the theme service resolves from.
			return typeof candidate.media === 'string' && candidate.media.includes('prefers-color-scheme');
		}

		/**
		 * Shadow `matches` on one real MediaQueryList with a value we own. The
		 * instance keeps its prototype, its listeners, and every other property, so
		 * nothing downstream can tell the difference.
		 * @returns whether the shadow took (a non-configurable property will not).
		 */
		function shadowMatches(mql, read, generation) {
			try {
				Object.defineProperty(mql, 'matches', { configurable: true, enumerable: true, get: read });
				mql[OWNED] = generation;
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * A deadline for one probe. `AbortSignal.timeout` exists in Safari 16+; where
		 * it does not, the arm-before-await schedule already keeps the loop alive.
		 */
		function abortSignal() {
			return AbortSignal?.timeout?.(PROBE_TIMEOUT_MS);
		}

		function makeChangeEvent(mql, matches) {
			// A real MediaQueryListEvent when available: a subscriber written against the
			// spec reads `event.matches`, and `undefined` there would be a trap for them.
			if (typeof MediaQueryListEvent === 'function') {
				try {
					return new MediaQueryListEvent('change', { matches, media: mql.media });
				} catch {}
			}
			if (typeof Event === 'function') return new Event('change');
			const event = document.createEvent('Event');
			event.initEvent('change', false, false);
			return event;
		}

		function apply(ctx, config = {}) {
			if (config.enabled === false || !isDesktopShell()) return;
			const theme = ctx.theme;
			const media = theme?.media;
			// No sensor we recognize (media query unsupported, a theme service without
			// one, or some other query): leave the application exactly as it is.
			if (!isColorSchemeSensor(media)) return;
			// Already ours (a reload that skipped teardown): do not stack a second loop.
			if (typeof window[GENERATION] === 'number' && media[OWNED] === window[GENERATION]) return;

			// A bare leading slash is required: `//host/x` is protocol-relative and would
			// turn a configured path into an outbound cross-origin request.
			const configured = typeof config.path === 'string' && config.path.startsWith('/') && !config.path.startsWith('//');
			const path = configured ? config.path : PROBE_PATH;
			const fastMs = Math.max(Number.isFinite(config.pollMs) ? config.pollMs : POLL_MS, MIN_POLL_MS);

			// Everything lives inside one effect: cordis runs the body immediately and
			// calls what it returns on teardown, so arming the timer here (rather than
			// passing `stop` as the body) is what keeps it from outliving the plugin.
			ctx.effect(() => {
				// Seed with the current reading so the first probe is the only seed.
				let dark = media.matches === true;
				let seeded = false;
				let pending = null;
				let pendingCount = 0;
				let failures = 0;
				let misses = 0;
				let inFlight = false;
				let stopped = false;
				let timer = null;
				let cadence = fastMs;

				// Install first: everything below assumes we own the reading. Each install
				// takes a generation number; an older closure sees it moved and stands down.
				const generation = (window[GENERATION] = (window[GENERATION] ?? 0) + 1);
				if (!shadowMatches(media, () => dark, generation)) return;

				const stop = () => {
					if (stopped) return;
					stopped = true;
					if (timer !== null) clearTimeout(timer);
					timer = null;
					document.removeEventListener('visibilitychange', onVisible);
					// Hand the sensor back: deleting the own shadow restores the
					// prototype getter, i.e. the browser's (pinned) reading.
					// Only hand back what we still own: a newer install may have taken the
					// same sensor over, and deleting then would un-shadow its work.
					try {
						if (media[OWNED] === generation) {
							delete media[OWNED];
							delete media.matches;
						}
					} catch {}
				};

				const arm = () => {
					if (stopped) return;
					if (timer !== null) clearTimeout(timer);
					timer = setTimeout(poll, cadence);
				};

				const slowTo = (ms) => {
					cadence = ms;
					arm();
				};

				const applyDark = (value) => {
					dark = value;
					ctx.logger?.debug?.('%s: appearance now %s', name, value ? 'dark' : 'light');
					// The theme service listens for `change` on this exact object and
					// re-resolves `system` from it; dispatching is all that is needed.
					try {
						media.dispatchEvent(makeChangeEvent(media, dark));
					} catch {
						if (typeof theme.publish === 'function') theme.publish();
					}
				};

				async function poll() {
					if (stopped) return;
					// Superseded by a newer install (reload without teardown, or a theme
					// service rebuilt underneath us): tear this closure down, quietly.
					if (window[GENERATION] !== generation) {
						stop();
						return;
					}
					// The service owns its sensor; if it ever swaps the MediaQueryList out
					// from under us, driving the old one would be a lie with no reader.
					// Revert to the native reading rather than keep a private fiction.
					if (ctx.theme?.media !== media) {
						ctx.logger?.warn?.('%s: theme service replaced its media query, reverting', name);
						stop();
						return;
					}
					// A hidden webview does not need a fresh theme, and re-arming here would
					// wake the cadence forever to do nothing: `onVisible` restarts the chain.
					if (document.visibilityState === 'hidden') return;
					// Never overlap requests, and always re-arm before awaiting: a hung
					// request must not be able to stall the loop, and two in-flight polls
					// would double-count failures.
					if (inFlight) return arm();
					inFlight = true;
					arm();
					let next = null;
					try {
						const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: abortSignal() });
						// 404/405 means the host half is not here at all (foreign profile,
						// `probe: false`): reverting is the honest answer, retrying is noise.
						if (response.status === 404 || response.status === 405) {
							inFlight = false;
							failures = 0;
							// A restart of the host, or a config hot-reload that has not
							// re-registered the route yet, can answer 404 once or twice.
							// One answer must not cost the theme for the whole session, so
							// the revert waits for a run of misses; until then: back off.
							misses += 1;
							if (misses === MISS_BUDGET) {
								ctx.logger?.warn?.('%s: no probe route at %s, reverting to the native media query', name, path);
								stop();
								return;
							}
							slowTo(BACKOFF_MS);
							return;
						}
						misses = 0;
						if (!response.ok) throw new Error(`probe ${response.status}`);
						const payload = await response.json();
						// `dark: null` is a valid host answer meaning "no trustworthy
						// reading on this platform"; count it with the transient failures.
						if (typeof payload?.dark !== 'boolean') throw new Error('probe unanswered');
						next = payload.dark;
					} catch {
						if (stopped) return;
						inFlight = false;
						misses = 0;
						failures += 1;
						// The next attempt is already armed from before the await; only a
						// cadence change needs to re-arm.
						if (failures === FAILURE_BUDGET && cadence !== BACKOFF_MS) {
							ctx.logger?.warn?.('%s: probe failing, slowing to %dms (native reading kept)', name, BACKOFF_MS);
							slowTo(BACKOFF_MS);
						}
						return;
					}
					inFlight = false;
					if (stopped) return;
					failures = 0;
					// One honest measurement is enough to trust the very first correction;
					// anything after it must repeat, because `defaults` can answer mid-flip
					// and a wrong guess repaints the whole application.
					const firstAnswer = seeded === false;
					seeded = true;
					if (cadence !== fastMs) slowTo(fastMs);
					if (next === dark) {
						pending = null;
						pendingCount = 0;
						return;
					}
					if (firstAnswer) {
						applyDark(next);
						return;
					}
					pendingCount = pending === next ? pendingCount + 1 : 1;
					pending = next;
					if (pendingCount < CONFIRMATIONS) return;
					pending = null;
					pendingCount = 0;
					applyDark(next);
				}

				const onVisible = () => {
					if (document.visibilityState === 'visible') void poll();
				};

				document.addEventListener('visibilitychange', onVisible);
				void poll();
				return stop;
			}, `${name}: os appearance follow`);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
