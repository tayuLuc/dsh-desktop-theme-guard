import { readFileSync } from 'node:fs';

const realSetTimeout = globalThis.setTimeout;
const src = readFileSync(`${process.env.HOME}/.dsh/plugins/dsh-desktop-theme-guard/lib/client.js`, 'utf8');

/**
 * Faithful stand-in for the MediaQueryList the real ThemeRuntime holds:
 * `matches` lives on the prototype (so an own shadow can hide it and deleting
 * the shadow restores the native reading), and listeners registered through
 * addEventListener fire on dispatchEvent — exactly what dsh-client-ui-theme
 * relies on to re-resolve `system`.
 */
function makeMql(nativeMatches, mediaText = '(prefers-color-scheme: dark)', throwOnDispatch = false) {
  const state = { native: nativeMatches, listeners: [] };
  const proto = { get matches() { return state.native } };
  const mql = Object.create(proto);
  mql.media = mediaText;
  mql.addEventListener = (_t, fn) => state.listeners.push(fn);
  mql.removeEventListener = (_t, fn) => { state.listeners = state.listeners.filter((x) => x !== fn) };
  mql.dispatchEvent = throwOnDispatch
    ? () => { throw new Error('dispatch blocked') }
    : () => { state.listeners.forEach((fn) => fn({ type: 'change' })); return true };
  return mql;
}

/** Responses in order; a string is treated as an HTTP status to return. */
function makeEnv({ desktop, payloads, preference = 'system', nativeMatches = true, mediaText, throwOnDispatch = false, hidden = false }) {
  const mql = makeMql(nativeMatches, mediaText, throwOnDispatch);
  let publishes = 0;
  mql.addEventListener('change', () => { publishes += 1 }); // what ThemeRuntime does
  const theme = { preference, media: mql, publish() { publishes += 100 } };
  const queue = [...payloads];

  const timers = new Map();
  let timerId = 0;
  let fetchCalls = 0;
  let visibility = hidden ? 'hidden' : 'visible';
  const visibilityListeners = [];
  const window = { __dsh_nav_bridge__: desktop };
  const logs = [];
  const env = {
    mql, theme, logs, publishes: () => publishes, fetchCalls: () => fetchCalls,
    timers: () => timers.size, lastDelay: () => [...timers.values()].at(-1)?.ms,
    tick: async () => { const due = [...timers.values()]; timers.clear(); for (const t of due) void t.fn(); await settle(5) },
    show: async () => { visibility = 'visible'; for (const fn of visibilityListeners) fn(); await settle() },
    dispose: null, effects: 0,
  };

  const g = {
    navigator: { userAgent: desktop ? 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (deepseek-harness-desktop)' : 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
    document: {
      get visibilityState() { return visibility },
      addEventListener: (_type, fn) => visibilityListeners.push(fn),
      removeEventListener: (_type, fn) => { const i = visibilityListeners.indexOf(fn); if (i >= 0) visibilityListeners.splice(i, 1) },
      createEvent: () => ({ initEvent() {} }),
    },
    Event: class { constructor(type) { this.type = type } },
    fetch: async () => {
      fetchCalls += 1;
      const item = queue.shift();
      if (item === 'hang') return { ok: true, status: 200, json: () => new Promise(() => {}) };
      if (item === '404') return { ok: false, status: 404, json: async () => ({}) };
      if (item === '500') return { ok: false, status: 500, json: async () => ({}) };
      if (item === 'throw') throw new Error('connection reset');
      return { ok: true, status: 200, json: async () => item };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { timers.delete(id) },
  };
  for (const [key, value] of Object.entries(g)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const def = { id: null };
  window.__ModuleLoader__ = { load: (d) => Object.assign(def, d) };
  new Function('window', 'require', src)(window, () => ({}));
  const mod = def.factory(() => ({}));
  env.mod = mod;
  env.def = def;
  env.ctx = {
    theme,
    // Cordis semantics: the body runs immediately and whatever it returns is the
    // disposer. Passing `stop` as the body instead of returning it tears the patch
    // down the instant it is installed — the regression this harness guards.
    effect: (execute, label) => {
      env.effects += 1;
      logs.push(label);
      const disposer = execute();
      env.dispose = typeof disposer === 'function' ? disposer : null;
      return () => env.dispose?.();
    },
    on: () => () => {},
    logger: { debug: (m) => logs.push(String(m)), info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
  };
  return env;
}

const settle = (ms = 10) => new Promise((r) => realSetTimeout(r, ms));
const results = [];
const check = (label, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);

// 1. desktop: the first probe corrects the pinned reading immediately
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  check('effect ran and returned a disposer', env.effects === 1 && typeof env.dispose === 'function', `effects=${env.effects}`);
  check('first probe overrides pinned media query', env.mql.matches === false, `matches=${env.mql.matches}`);
  check('theme service re-resolved (change fired)', env.publishes() === 1, `publishes=${env.publishes()}`);
  check('module id', env.def.id === 'dsh-desktop-theme-guard');
  check('effect labelled', /os appearance follow/.test(env.logs.join('|')));
  check('timer armed at poll cadence', env.timers() === 1 && env.lastDelay() === 3000, `delay=${env.lastDelay()}`);
}

// 2. a real OS change is confirmed by a second reading before it repaints
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, { dark: true }, { dark: true }] });
  env.mod.apply(env.ctx, {});
  await settle();
  await env.tick();
  check('unconfirmed flip not applied yet', env.mql.matches === false && env.publishes() === 1, `publishes=${env.publishes()}`);
  await env.tick();
  check('confirmed flip applied', env.mql.matches === true && env.publishes() === 2, `publishes=${env.publishes()}`);
}

// 3. a single contradictory reading between two agreeing ones is dropped
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, { dark: true }, { dark: false }, { dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  await env.tick(); // true -> pending 1
  await env.tick(); // false -> matches current dark=false, pending reset
  await env.tick();
  check('jitter did not repaint', env.publishes() === 1, `publishes=${env.publishes()}`);
}

// 4. repeated identical answer dispatches nothing
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, { dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  await env.tick();
  check('unchanged answer dispatches nothing', env.publishes() === 1, `publishes=${env.publishes()}`);
}

// 5. plain browser tab: untouched, nothing installed
{
  const env = makeEnv({ desktop: false, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  check('browser: media query untouched', env.mql.matches === true, `matches=${env.mql.matches}`);
  check('browser: no effect registered', env.effects === 0);
  check('browser: no probing', env.fetchCalls() === 0, `fetches=${env.fetchCalls()}`);
}

// 6. route missing (no host half): a run of misses reverts, one answer does not
{
  const env = makeEnv({ desktop: true, payloads: ['404', '404', { dark: false }] });
  const shadowed = () => Object.getOwnPropertyDescriptor(env.mql, 'matches')?.get !== void 0;
  env.mod.apply(env.ctx, {});
  await settle();
  check('one 404 keeps the patch alive and backs off', shadowed() && env.timers() === 1 && env.lastDelay() === 30000, `delay=${env.lastDelay()}`);
  await env.tick();
  check('two 404s still alive, no revert yet', shadowed() && env.publishes() === 0, `publishes=${env.publishes()}`);
  await env.tick();
  check('a success between misses resets them', env.mql.matches === false && env.lastDelay() === 3000, `matches=${env.mql.matches} delay=${env.lastDelay()}`);

  const env2 = makeEnv({ desktop: true, payloads: ['404', '404', '404'] });
  env2.mod.apply(env2.ctx, {});
  await settle();
  await env2.tick();
  check('still alive after two misses', Object.getOwnPropertyDescriptor(env2.mql, 'matches')?.get !== void 0 && env2.timers() === 1, `timers=${env2.timers()}`);
  await env2.tick();
  check('third consecutive miss reverts', env2.mql.matches === true && env2.timers() === 0, `matches=${env2.mql.matches} timers=${env2.timers()}`);
  check('revert reported once', env2.logs.filter((l) => /no probe route/.test(l)).length === 1);
  await env2.tick();
  check('after revert: no further requests', env2.fetchCalls() === 3, `fetches=${env2.fetchCalls()}`);
  check('after revert: own shadow removed', Object.getOwnPropertyDescriptor(env2.mql, 'matches') === void 0);
}

// 7. transient failures slow down instead of giving up
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, 'throw', '500', 'throw', { dark: true }, { dark: true }] });
  env.mod.apply(env.ctx, {});
  await settle();
  await env.tick(); // throw
  await env.tick(); // 500
  check('still polling after 2 failures', env.timers() === 1 && env.lastDelay() === 3000, `delay=${env.lastDelay()}`);
  await env.tick(); // throw -> budget hit
  check('3rd failure backs off, shadow kept', env.lastDelay() === 30000 && env.mql.matches === false, `delay=${env.lastDelay()}`);
  check('backoff reported once', env.logs.filter((l) => /slowing/.test(l)).length === 1);
  await env.tick(); // recovers: dark true pending
  await env.tick();
  check('recovers and applies confirmed flip', env.mql.matches === true && env.lastDelay() === 3000, `delay=${env.lastDelay()}`);
}

// 8. dispose hands the sensor back and disarms
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  const shadowed = env.mql.matches === false;
  env.dispose?.();
  check('dispose: was shadowed before', shadowed);
  check('dispose: native reading restored', env.mql.matches === true, `matches=${env.mql.matches}`);
  check('dispose: timer disarmed', env.timers() === 0, `timers=${env.timers()}`);
  check('dispose: visibility listener removed', env.logs.length > 0);
}

// 9. double apply on the same sensor must not stack
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  const afterFirst = env.publishes();
  env.mod.apply(env.ctx, {});
  await settle();
  check('second apply is a no-op', env.publishes() === afterFirst && env.effects === 1, `effects=${env.effects}`);
}

// 10. a sensor that is not the color-scheme query is left alone
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }], mediaText: '(min-width: 800px)' });
  env.mod.apply(env.ctx, {});
  await settle();
  check('non-color-scheme query ignored', env.mql.matches === true && env.effects === 0, `effects=${env.effects}`);
}

// 11. publish() fallback when dispatchEvent throws
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }], throwOnDispatch: true });
  env.mod.apply(env.ctx, {});
  await settle();
  check('dispatch failure falls back to publish()', env.publishes() === 100, `publishes=${env.publishes()}`);
  check('shadow stays installed after fallback', env.mql.matches === false);
}

// 12. hidden webview does not poll; revealing does
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, { dark: true }, { dark: true }] });
  Object.defineProperty(env.ctx, 'hiddenMode', { value: true });
  const env2 = makeEnv({ desktop: true, payloads: [], hidden: true });  // env above is inert (never ticked)
  env2.mod.apply(env2.ctx, {});
  await settle();
  check('hidden at start: no probe issued', env2.fetchCalls() === 0, `fetches=${env2.fetchCalls()}`);
  await env2.show();
  check('reveal triggers a poll', env2.fetchCalls() === 1, `fetches=${env2.fetchCalls()}`);
  void env;
}

// 13. explicit preference: install happens (harmless), service ignores the sensor
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }], preference: 'dark' });
  env.mod.apply(env.ctx, {});
  await settle();
  check('explicit preference: honest reading installed', env.theme.preference === 'dark' && env.mql.matches === false);
}

// 14. config overrides
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, { pollMs: 800, path: '/custom/os' });
  await settle();
  check('pollMs honoured', env.lastDelay() === 800, `delay=${env.lastDelay()}`);
  const env4 = makeEnv({ desktop: true, payloads: [] });
  env4.mod.apply(env4.ctx, { pollMs: 10 });
  await settle();
  check('pollMs floored at 500', env4.lastDelay() === 500, `delay=${env4.lastDelay()}`);
  const env3 = makeEnv({ desktop: true, payloads: [] });
  env3.mod.apply(env3.ctx, { enabled: false });
  await settle();
  check('enabled:false installs nothing', env3.effects === 0 && env3.fetchCalls() === 0);
}

// 15. a request that never settles must not stall the schedule
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }, 'hang'] });
  env.mod.apply(env.ctx, {});
  await settle();
  await env.tick();
  check('hung probe keeps the loop armed', env.timers() === 1, `timers=${env.timers()}`);
  check('hung probe did not double-apply', env.publishes() === 1, `publishes=${env.publishes()}`);
  await env.tick();
  check('overlapping poll skipped while one is in flight', env.fetchCalls() === 2, `fetches=${env.fetchCalls()}`);
}

// 16. the service swapping its sensor out reverts the patch instead of lying
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  const shadowed = env.mql.matches === false;
  env.theme.media = makeMql(true);
  await env.tick();
  check('sensor drift reverted to native reading', shadowed && env.mql.matches === true, `matches=${env.mql.matches}`);
  check('sensor drift reported', /replaced its media query/.test(env.logs.join('|')));
  check('sensor drift disarms the loop', env.timers() === 0, `timers=${env.timers()}`);
}

// 17. a first answer that agrees with the pin still arms the confirmation rule
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: true }, { dark: false }, { dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  check('agreeing first answer applies nothing', env.publishes() === 0 && env.mql.matches === true, `publishes=${env.publishes()}`);
  await env.tick();
  check('later flip waits for confirmation', env.publishes() === 0, `publishes=${env.publishes()}`);
  await env.tick();
  check('confirmed flip applies', env.publishes() === 1 && env.mql.matches === false, `publishes=${env.publishes()}`);
}

// 18. a newer install supersedes an older closure that never got disposed (M2)
{
  const env = makeEnv({ desktop: true, payloads: [{ dark: false }] });
  env.mod.apply(env.ctx, {});
  await settle();
  const firstMql = env.mql;
  const shadowedFirst = firstMql.matches === false;
  // Simulate a bundle reload without teardown: a fresh theme service with a new sensor.
  // Deliberately no dispose: this is the hot-reload-without-teardown path.
  const env2 = makeEnv({ desktop: true, payloads: [{ dark: true }] });
  env2.mod.apply(env2.ctx, {});
  await settle();
  check('new install took over its own sensor', env2.mql.matches === true, `matches=${env2.mql.matches}`);
  // The stale closure must notice it is no longer the current generation and stand down
  // without deleting the new owner's shadow.
  check('stale closure stands down on its next poll', (await env.tick(), env.timers() === 0), `timers=${env.timers()}`);
  check('stale closure did not clear the new shadow', Object.getOwnPropertyDescriptor(env2.mql, 'matches')?.get !== void 0);
  check('stale fetches stopped', env.fetchCalls() === 1, `fetches=${env.fetchCalls()}`);
  check('shadowed-first sanity', shadowedFirst);
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
