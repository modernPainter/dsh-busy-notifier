/**
 * Node-side Loader seat for @huaqiu/dsh-busy-notifier.
 *
 * Embeds deployment config from cordis.patch.yml into the page as
 * `window.__DSH_BUSY_NOTIFIER_CONFIG__` before client bundles run.
 */

const BOOT_KEY = '__DSH_BUSY_NOTIFIER_CONFIG__';

const DEFAULT_BUSY_FIELDS = [
  'is_busy',
  'isBusy',
  'busy',
  'degraded',
  'is_degraded',
  'server_busy',
];

const DEFAULT_PUBLIC_PROVIDERS = [
  'deepseek',
  'kimi',
  'moonshot',
  'openai',
  'anthropic',
  'qwen',
];

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  return cleaned;
}

/** Normalize deployment config, falling back to safe defaults. */
export function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const cooldownMinutes = typeof raw.cooldownMinutes === 'number' && raw.cooldownMinutes > 0
    ? raw.cooldownMinutes
    : 30;
  return {
    cooldownMinutes,
    busyFields: normalizeStringArray(raw.busyFields, DEFAULT_BUSY_FIELDS),
    publicProviders: normalizeStringArray(raw.publicProviders, DEFAULT_PUBLIC_PROVIDERS),
    selfHostedProviders: normalizeStringArray(raw.selfHostedProviders, []),
  };
}

function serialize(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Insert the boot script right after <body>, ahead of module scripts. */
export function injectBootConfig(html, config) {
  const script = `<script>window.${BOOT_KEY} = ${serialize(resolveConfig(config))}</script>`;
  const body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body === null) return `${html}${script}`;
  const at = body.index + body[0].length;
  return `${html.slice(0, at)}${script}${html.slice(at)}`;
}

/** Register the index transform once webServer is available. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex((html) => injectBootConfig(html, resolved)),
      'busy-notifier: boot config',
    );
  });
}
