/** Deployment-level settings for `@huaqiu/dsh-busy-notifier`, supplied via `cordis.patch.yml`. */
export interface BusyNotifierConfig {
  /** Cooldown window in minutes after the user clicks close (`×`). Default: 30. */
  cooldownMinutes: number;
  /** Candidate field names emitted by the backend to signal busy/degraded state. */
  busyFields: string[];
  /** Provider keywords treated as public models (switching to them hides banner & clears dismiss record). */
  publicProviders: string[];
  /** Optional explicit provider keywords treated as self-hosted models. Empty means any non-public provider. */
  selfHostedProviders: string[];
}

export interface WebServerService {
  tapIndex(transform: (html: string) => string): void;
}

export interface WebServerScope {
  effect(factory: () => void, label?: string): void;
  webServer: WebServerService;
}

export interface HostContext {
  inject(dependencies: string[], factory: (scope: WebServerScope) => void): void;
}

export function resolveConfig(config?: unknown): BusyNotifierConfig;
export function injectBootConfig(html: string, config?: unknown): string;
export function apply(ctx: HostContext, config?: unknown): void;
