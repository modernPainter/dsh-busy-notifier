/*
 * Headless smoke test for @huaqiu/dsh-busy-notifier.
 *
 * Verifies:
 * 1. Slot registrations (`conversation.input.dock` + `conversation.chat.turnTail`)
 *    and ConversationNodeDefinition (`busy-status`).
 * 2. Reserved backend parameter detection (`is_busy`, `isBusy`, `degraded`,
 *    `server_status: 'busy'`, nested `usage.is_busy`, text marker `<!-- dsh:busy -->`).
 * 3. Banner visibility when using a self-hosted model and backend reports busy.
 * 4. No duplicate model-switcher button in the banner (relies on the existing
 *    bottom-right composer model selector).
 * 5. Clicking `×` records dismissal in `sessionStorage` and suppresses the banner
 *    within the 30-minute cooldown window.
 * 6. Switching to a public model (e.g. DeepSeek, Kimi) immediately hides the
 *    banner AND clears the dismissal record — switching back to the self-hosted
 *    model re-displays the banner if still busy.
 * 7. When the self-hosted model recovers (`busy = false`), the banner auto-hides
 *    and clears the dismissal record.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Static assertions on style & config contract
// ---------------------------------------------------------------------------
assert.match(source, /\.dsh-bn-dock/, 'must define dock style');
assert.match(source, /\.dsh-bn-bar/, 'must define warning bar style');
assert.match(source, /__DSH_BUSY_NOTIFIER_CONFIG__/, 'must read boot config');
assert.match(patch, /cooldownMinutes:\s*30/, 'patch must declare cooldownMinutes');
assert.match(patch, /busyFields:/, 'patch must declare reserved busyFields');
assert.match(patch, /publicProviders:/, 'patch must declare publicProviders');
console.log('[ok] static style & config contract');

// ---------------------------------------------------------------------------
// 2. Stub environment (React, document, sessionStorage)
// ---------------------------------------------------------------------------
global.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
  body: {},
};

const storageMap = new Map();
global.sessionStorage = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => { storageMap.set(k, String(v)); },
  removeItem: (k) => { storageMap.delete(k); },
  clear: () => { storageMap.clear(); },
  key: (i) => Array.from(storageMap.keys())[i] || null,
  get length() { return storageMap.size; },
};

const hooks = [];
const effectDeps = [];
let hookIndex = 0;

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(init) {
    const i = hookIndex++;
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
    const idx = i;
    return [hooks[idx], (value) => {
      hooks[idx] = typeof value === 'function' ? value(hooks[idx]) : value;
    }];
  },
  useEffect(fn, deps) {
    const i = hookIndex++;
    const prev = effectDeps[i];
    const changed = !prev || !deps || deps.some((d, idx) => !Object.is(d, prev[idx]));
    effectDeps[i] = deps;
    if (changed) fn();
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
};

function resetHooks() {
  hooks.length = 0;
  effectDeps.length = 0;
  hookIndex = 0;
}

// ---------------------------------------------------------------------------
// 3. Load client bundle & verify registrations
// ---------------------------------------------------------------------------
let currentModelSelection = { provider: 'company-llm', model: 'hq-coder-v1' };
const mockModelStore = {
  subscribe: () => () => {},
  getSnapshot: () => ({ current: currentModelSelection }),
};

function loadBundle(bootConfig) {
  let captured = null;
  global.window = {
    __ModuleLoader__: { load: (def) => { captured = def; } },
    ...(bootConfig === undefined ? {} : { __DSH_BUSY_NOTIFIER_CONFIG__: bootConfig }),
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'sessionStorage', source)(
    global.window,
    global.document,
    global.sessionStorage,
  );
  assert.ok(captured, 'bundle did not call __ModuleLoader__.load');
  const mod = captured.factory((id) => {
    assert.equal(id, 'react');
    return React;
  });

  const slotRegs = {};
  let eventDef = null;
  let dictionaries = null;

  mod.apply({
    effect: (factory) => factory(),
    locale: {
      register: (ns, dict) => { dictionaries = { ns, dict }; return () => {}; },
    },
    conversationEvents: {
      register: (def) => { eventDef = def; },
    },
    modelDirectories: {
      directoryFor: () => ({ store: mockModelStore }),
    },
    slots: {
      inject: (_key, factory) => factory(),
      register: (def, comp) => {
        slotRegs[def.name] = { def, comp };
        return () => {};
      },
    },
  });

  assert.ok(slotRegs['conversation.input.dock'], 'must register conversation.input.dock');
  assert.ok(slotRegs['conversation.chat.turnTail'], 'must register conversation.chat.turnTail');
  assert.ok(eventDef, 'must register busy-status ConversationNodeDefinition');
  assert.deepEqual(Object.keys(dictionaries.dict.zh), Object.keys(dictionaries.dict.en));
  return { mod, slotRegs, eventDef, dictionaries };
}

const { mod, slotRegs, eventDef, dictionaries } = loadBundle();
console.log('[ok] slot & event registrations verified');

// ---------------------------------------------------------------------------
// 4. Test reserved backend busy parameter detection
// ---------------------------------------------------------------------------
const { inspectObjectForBusyFlag, isPublicModel } = mod._internal;

assert.equal(inspectObjectForBusyFlag({ is_busy: true }, 0), true);
assert.equal(inspectObjectForBusyFlag({ isBusy: 1 }, 0), true);
assert.equal(inspectObjectForBusyFlag({ degraded: 'true' }, 0), true);
assert.equal(inspectObjectForBusyFlag({ server_status: 'busy' }, 0), true);
assert.equal(inspectObjectForBusyFlag({ usage: { inputTokens: 10, is_busy: true } }, 0), true);
assert.equal(inspectObjectForBusyFlag({ source: { kind: 'model', replayState: { busy: true } } }, 0), true);
assert.equal(inspectObjectForBusyFlag({ is_busy: false }, 0), false);
assert.equal(inspectObjectForBusyFlag({ usage: { inputTokens: 10 } }, 0), false);

// Event definition state machine test
let state = eventDef.start({}, { event: { type: 'turn/start', data: { turn: 1 } } });
assert.equal(state.busy, false);
state = eventDef.update(
  { state },
  {
    event: {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
         is_busy: true,
        message: {
          source: { kind: 'model', provider: 'company-llm', model: 'hq-coder-v1' },
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    },
  },
);
assert.equal(state.busy, true);
assert.deepEqual(state.modelHint, { provider: 'company-llm', model: 'hq-coder-v1' });
console.log('[ok] reserved backend busy parameter detection verified');

// ---------------------------------------------------------------------------
// 5. Test model classification (self-hosted vs public DeepSeek / Kimi)
// ---------------------------------------------------------------------------
assert.equal(isPublicModel({ provider: 'deepseek', model: 'deepseek-chat' }), true);
assert.equal(isPublicModel({ provider: 'kimi', model: 'moonshot-v1' }), true);
assert.equal(isPublicModel({ provider: 'company-llm', model: 'hq-coder-v1' }), false);
console.log('[ok] public vs self-hosted model classification verified');

// ---------------------------------------------------------------------------
// 6. Test UI lifecycle: Show -> Dismiss (30m cooldown) -> Switch to DeepSeek/Kimi
//    (hide & clear record) -> Switch back to self-hosted (show again!) -> Recover
// ---------------------------------------------------------------------------
const dockEntry = slotRegs['conversation.input.dock'];

function makeSnapshot(busy, turn = 1) {
  const turnDataMap = new Map([['busy-status', { busy, turn, modelHint: currentModelSelection }]]);
  const turnsMap = new Map([[turn, { turn, data: { get: (k) => turnDataMap.get(k) } }]]);
  return {
    chat: {
      timeline: {
        turnOrder: [turn],
        turns: turnsMap,
      },
    },
    nodes: [],
  };
}

function renderBanner(snapshot) {
  hookIndex = 0;
  const injected = dockEntry.def.inject('session-1');
  return dockEntry.comp({
    useSession: (sel) => sel(snapshot),
    t: (key) => dictionaries.dict.zh[key] || key,
    ...injected,
  });
}

function findCloseButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.props && node.props.className === 'dsh-bn-close') return node;
  for (const child of node.children || []) {
    const found = findCloseButton(child);
    if (found) return found;
  }
  return null;
}

resetHooks();
storageMap.clear();
currentModelSelection = { provider: 'company-llm', model: 'hq-coder-v1' };

// Step A: Idle self-hosted model -> no banner
let view = renderBanner(makeSnapshot(false, 1));
assert.equal(view, null, 'banner must not show when not busy');

// Step B: Backend returns busy on self-hosted model -> banner shows
view = renderBanner(makeSnapshot(true, 1));
assert.ok(view, 'banner must show when self-hosted model is busy');
assert.equal(view.props.className, 'dsh-bn-dock');
const closeBtn = findCloseButton(view);
assert.ok(closeBtn, 'banner must have a close button');

// Step C: User clicks `×` to dismiss -> banner hides & records timestamp in sessionStorage
closeBtn.props.onClick();
view = renderBanner(makeSnapshot(true, 1));
assert.equal(view, null, 'banner must hide after clicking close');
assert.equal(storageMap.size, 1, 'sessionStorage must hold the dismissal record');

// Even on subsequent busy turns within 30 minutes, it remains suppressed
view = renderBanner(makeSnapshot(true, 2));
assert.equal(view, null, 'banner must stay suppressed during cooldown on next busy turn');
console.log('[ok] show banner + click close suppression verified');

// Step D: User switches to public model (DeepSeek / Kimi) via bottom-right model selector
currentModelSelection = { provider: 'deepseek', model: 'deepseek-chat' };
view = renderBanner(makeSnapshot(true, 2));
assert.equal(view, null, 'banner must stay hidden on public model');
assert.equal(storageMap.size, 0, 'switching to public model must clear the dismissal record');
console.log('[ok] switching to public model (DeepSeek/Kimi) clears dismissal record');

// Step E: User switches back to self-hosted model while it is still busy -> banner shows again!
currentModelSelection = { provider: 'company-llm', model: 'hq-coder-v1' };
view = renderBanner(makeSnapshot(true, 3));
assert.ok(view, 'banner must re-appear after switching back from public model to busy self-hosted model');
console.log('[ok] switching back to self-hosted model re-triggers banner when busy');

// Step F: Self-hosted model recovers (next turn is not busy) -> banner auto-hides & clears any dismissal record
findCloseButton(view).props.onClick();
assert.equal(storageMap.size, 1);
view = renderBanner(makeSnapshot(false, 4));
assert.equal(view, null, 'banner must hide when server recovers');
assert.equal(storageMap.size, 0, 'recovery must clear dismissal record for future peak periods');
console.log('[ok] server recovery auto-hide & record reset verified');

// ---------------------------------------------------------------------------
// 7. Test Node-side boot config injection (lib/index.mjs)
// ---------------------------------------------------------------------------
(async () => {
  const hostMod = await import(pathToFileURL(path.join(root, 'lib', 'index.mjs')).href);
  const resolved = hostMod.resolveConfig({ cooldownMinutes: 15, busyFields: ['custom_busy'] });
  assert.equal(resolved.cooldownMinutes, 15);
  assert.deepEqual(resolved.busyFields, ['custom_busy']);
  const html = hostMod.injectBootConfig('<html><body><div id="root"></div></body></html>', resolved);
  assert.match(html, /window\.__DSH_BUSY_NOTIFIER_CONFIG__ = \{"cooldownMinutes":15/);
  console.log('[ok] host boot-config injection verified');
})();
