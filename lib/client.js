/*
 * @huaqiu/dsh-busy-notifier — browser half (hand-written client bundle).
 *
 * Renders a non-modal warning banner in `conversation.input.dock` (and optional
 * inline notice in `conversation.chat.turnTail`) when the backend passes a
 * busy/degraded parameter in the conversation session content/events.
 *
 * Core state & frequency rules:
 * 1. Banner only appears when the active model belongs to a self-hosted provider
 *    AND the latest turn/response carries the backend busy parameter.
 * 2. Clicking `×` records a dismissal timestamp in `sessionStorage` so the
 *    banner stays hidden during the cooldown window (default 30 minutes).
 * 3. Switching to a public model (e.g. DeepSeek, Kimi) immediately hides the
 *    banner AND clears the dismissal record — so if the user later switches
 *    back to the self-hosted model while it is still busy, the reminder
 *    triggers again.
 * 4. When the self-hosted model recovers (a subsequent response returns without
 *    the busy parameter), the banner auto-hides and the dismissal record is
 *    cleared for future peak periods.
 * 5. No duplicate model-switcher button is rendered; the banner guides the user
 *    to switch via the existing model selector at the bottom-right of the
 *    composer input bar.
 */
window.__ModuleLoader__.load({
  id: "@huaqiu/dsh-busy-notifier",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useSyncExternalStore } = React;

    const PLUGIN_ID = "@huaqiu/dsh-busy-notifier";
    const NS = "busy.notifier";
    const CSS_ID = PLUGIN_ID + "/styles";
    const STORAGE_KEY_PREFIX = "dsh_busy_banner_dismissed_at:";

    const DEFAULT_BUSY_FIELDS = [
      "is_busy",
      "isBusy",
      "busy",
      "degraded",
      "is_degraded",
      "server_busy",
    ];

    const DEFAULT_PUBLIC_PROVIDERS = [
      "deepseek",
      "kimi",
      "moonshot",
      "openai",
      "anthropic",
      "qwen",
    ];

    const rawConfig = (typeof window !== "undefined" && window.__DSH_BUSY_NOTIFIER_CONFIG__) || {};
    const CONFIG = {
      cooldownMinutes: typeof rawConfig.cooldownMinutes === "number" && rawConfig.cooldownMinutes > 0
        ? rawConfig.cooldownMinutes
        : 30,
      busyFields: Array.isArray(rawConfig.busyFields) && rawConfig.busyFields.length > 0
        ? rawConfig.busyFields
        : DEFAULT_BUSY_FIELDS,
      publicProviders: Array.isArray(rawConfig.publicProviders) && rawConfig.publicProviders.length > 0
        ? rawConfig.publicProviders.map((s) => String(s).toLowerCase())
        : DEFAULT_PUBLIC_PROVIDERS,
      selfHostedProviders: Array.isArray(rawConfig.selfHostedProviders)
        ? rawConfig.selfHostedProviders.map((s) => String(s).toLowerCase())
        : [],
    };

    const STYLE = `
.dsh-bn-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) * 2 -
    var(--dsh-composer-dock-inset, 6px) * 4
  );
  margin: 0 auto 6px;
}
.dsh-bn-bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 6px));
  min-height: 38px;
  margin: 0 auto;
  padding: 6px 8px 6px 12px;
  border: 1px solid rgba(217, 119, 6, 0.35);
  border-radius: 12px;
  background: var(--dsw-specific-tip, rgba(245, 158, 11, 0.10));
  color: var(--dsw-alias-label-primary, #1f2937);
  font-size: 13px;
  line-height: 20px;
}
.dsh-bn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(217, 119, 6, 0.16);
  color: #d97706;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}
.dsh-bn-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}
.dsh-bn-title {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-bn-desc {
  color: var(--dsw-alias-label-secondary, rgba(107, 114, 128, 1));
  font-size: 12.5px;
}
.dsh-bn-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.dsh-bn-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-bn-tail {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.10);
  color: #b45309;
  font-size: 12px;
  line-height: 18px;
}
`;

    const zh = {
      "banner.title": "当前自研模型算力繁忙，响应速度或输出质量可能下降",
      "banner.desc": "建议通过右下角模型选择器临时切换至 DeepSeek、Kimi 等公用模型。",
      "banner.close": "关闭提示",
      "tail.badge": "⚡ 算力高峰期降级响应",
    };

    const en = {
      "banner.title": "Self-hosted model is currently busy; response speed or quality may degrade",
      "banner.desc": "Consider switching to a public model (e.g. DeepSeek, Kimi) via the model selector at the bottom-right.",
      "banner.close": "Dismiss",
      "tail.badge": "⚡ Degraded response during peak load",
    };

    function installStyle() {
      const existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
      if (existing !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    /**
     * Check whether an object carries any configured backend busy/degraded flag.
     * Reserved for flexible backend parameter conventions:
     * - boolean `true` or numeric `1` on any field in `CONFIG.busyFields`
     * - string `"true"`, `"busy"`, `"degraded"`, `"high"`, `"overload"`
     * - nested inside `usage`, `meta`, `source`, `replayState`, `data`, or `details`
     */
    function isTruthyBusyValue(val) {
      if (val === true || val === 1) return true;
      if (typeof val === "string") {
        const lower = val.trim().toLowerCase();
        return lower === "true" || lower === "busy" || lower === "degraded" || lower === "high" || lower === "overload";
      }
      return false;
    }

    function inspectObjectForBusyFlag(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 3) return false;
      for (let i = 0; i < CONFIG.busyFields.length; i++) {
        const key = CONFIG.busyFields[i];
        if (key in obj && isTruthyBusyValue(obj[key])) return true;
      }
      if (typeof obj.server_status === "string" || typeof obj.serverStatus === "string") {
        const status = String(obj.server_status || obj.serverStatus).toLowerCase();
        if (status === "busy" || status === "degraded" || status === "overload") return true;
      }
      const nestedKeys = ["usage", "meta", "source", "replayState", "data", "details", "extra", "chunk", "message"];
      for (let i = 0; i < nestedKeys.length; i++) {
        const k = nestedKeys[i];
        if (obj[k] && typeof obj[k] === "object") {
          if (inspectObjectForBusyFlag(obj[k], depth + 1)) return true;
        }
      }
      return false;
    }

    /**
     * Reserved text/marker fallback: if the backend injects a hidden marker or
     * context notice in the conversation content (e.g. `<!-- dsh:busy -->` or
     * `[SERVER_BUSY]`), recognize it as well.
     */
    function inspectBlocksForBusyMarker(blocks) {
      if (!Array.isArray(blocks)) return false;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || typeof b !== "object") continue;
        if (inspectObjectForBusyFlag(b, 0)) return true;
        if (typeof b.text === "string" && (b.text.includes("<!-- dsh:busy -->") || b.text.includes("[DSH_SERVER_BUSY]"))) {
          return true;
        }
      }
      return false;
    }

    /**
     * Determine whether a provider/model selection is a public model vs
     * company self-hosted model.
     */
    function isPublicModel(selection) {
      if (!selection || typeof selection !== "object") return false;
      const provider = String(selection.provider || "").toLowerCase();
      const model = String(selection.model || "").toLowerCase();
      if ( provider === "" && model === "" ) return false;

      if (CONFIG.selfHostedProviders.length > 0) {
        const isExplicitSelf = CONFIG.selfHostedProviders.some(
          (kw) => provider.includes(kw) || model.includes(kw),
        );
        if (isExplicitSelf) return false;
      }

      return CONFIG.publicProviders.some(
        (kw) => provider.includes(kw) || model.includes(kw),
      );
    }

    function storageKeyFor(modelKey) {
      return STORAGE_KEY_PREFIX + (modelKey || "default");
    }

    function readDismissedAt(modelKey) {
      try {
        if (typeof sessionStorage === "undefined") return null;
        const raw = sessionStorage.getItem(storageKeyFor(modelKey));
        if (!raw) return null;
        const ts = Number(raw);
        return Number.isFinite(ts) ? ts : null;
      } catch (_e) {
        return null;
      }
    }

    function writeDismissedAt(modelKey, timestamp) {
      try {
        if (typeof sessionStorage === "undefined") return;
        sessionStorage.setItem(storageKeyFor(modelKey), String(timestamp));
      } catch (_e) {
        // Ignore storage quota / security errors.
      }
    }

    function clearDismissedAt(modelKey) {
      try {
        if (typeof sessionStorage === "undefined") return;
        if (modelKey) {
          sessionStorage.removeItem(storageKeyFor(modelKey));
        }
        // Also clear all keys starting with STORAGE_KEY_PREFIX when switching to public model.
        const keysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.indexOf(STORAGE_KEY_PREFIX) === 0) keysToRemove.push(k);
        }
        for (let i = 0; i < keysToRemove.length; i++) {
          sessionStorage.removeItem(keysToRemove[i]);
        }
      } catch (_e) {
        // Ignore storage errors.
      }
    }

    function isWithinCooldown(dismissedAt, now) {
      if (dismissedAt === null) return false;
      const cooldownMs = CONFIG.cooldownMinutes * 60 * 1000;
      return now - dismissedAt < cooldownMs;
    }

    /**
     * Evaluate whether the latest turn/response in the session snapshot (or
     * ConversationLocationData on the latest Turn) carries the busy signal.
     */
    function deriveSessionBusyState(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return { busy: false, turn: null, modelHint: null };
      }

      // 1. Check custom Turn-scoped location data published by our ConversationNodeDefinition.
      const timeline = snapshot.chat && snapshot.chat.timeline;
      if (timeline && Array.isArray(timeline.turnOrder) && timeline.turnOrder.length > 0) {
        const latestTurnNum = timeline.turnOrder[timeline.turnOrder.length - 1];
        const turnLoc = timeline.turns && typeof timeline.turns.get === "function"
          ? timeline.turns.get(latestTurnNum)
          : undefined;
        if (turnLoc && turnLoc.data && typeof turnLoc.data.get === "function") {
          const turnBusy = turnLoc.data.get("busy-status");
          if (turnBusy && typeof turnBusy.busy === "boolean") {
            return {
              busy: turnBusy.busy,
              turn: latestTurnNum,
              modelHint: turnBusy.modelHint || null,
            };
          }
        }
      }

      // 2. Fallback: inspect legacy finalized nodes & partial in snapshot.
      if (snapshot.partial && inspectBlocksForBusyMarker(snapshot.partial.blocks)) {
        return { busy: true, turn: snapshot.partial.turn, modelHint: null };
      }

      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (!node) continue;
        if (node.kind === "assistant") {
          const busy = inspectObjectForBusyFlag(node, 0) || inspectBlocksForBusyMarker(node.blocks);
          const modelHint = node.provenance || node.requestConfig || null;
          return { busy, turn: node.turn, modelHint };
        }
        if (node.kind === "model-retry") {
          // A live model-retry on rate-limit / overload also signals server busyness.
          if (node.retryState === "scheduled" || node.retryState === "started") {
            return { busy: true, turn: node.turn, modelHint: null };
          }
        }
      }

      return { busy: false, turn: null, modelHint: null };
    }

    /**
     * ConversationNodeDefinition that watches raw session events (`assistant/message`,
     * `assistant/chunk`, `user/message`, `llm/retry`, `turn/end`, etc.) per turn
     * and publishes `{ busy, turn, modelHint }` to `turn.data.get('busy-status')`.
     */
    const busyTurnDefinition = {
      kind: "busy-status",
      match(event) {
        if (!event || typeof event !== "object") return null;
        if (event.type === "turn/start") {
          return { id: String(event.data.turn), role: "start" };
        }
        if (
          event.type === "assistant/chunk" ||
          event.type === "assistant/message" ||
          event.type === "llm/retry" ||
          event.type === "turn/end"
        ) {
          if (event.data && typeof event.data.turn === "number") {
            return { id: String(event.data.turn), role: "update" };
          }
        }
        return null;
      },
      start(_context, match) {
        const turn = match.event.data.turn;
        return {
          turn: turn,
          busy: inspectObjectForBusyFlag(match.event.data, 0),
          modelHint: null,
        };
      },
      update(context, match) {
        const prev = context.state || { turn: 0, busy: false, modelHint: null };
        const ev = match.event;
        let busy = prev.busy;
        let modelHint = prev.modelHint;

        if (inspectObjectForBusyFlag(ev.data, 0)) {
          busy = true;
        }
        if (ev.type === "assistant/message" && ev.data && ev.data.message) {
          const msg = ev.data.message;
          if (msg.source && msg.source.kind === "model") {
            modelHint = { provider: msg.source.provider, model: msg.source.model };
          }
          if (inspectObjectForBusyFlag(msg, 0) || inspectBlocksForBusyMarker(msg.content)) {
            busy = true;
          }
        }
        if (ev.type === "assistant/chunk" && ev.data && ev.data.chunk) {
          const chunk = ev.data.chunk;
          if (inspectObjectForBusyFlag(chunk, 0)) {
            busy = true;
          }
          if (chunk.type === "text-delta" && typeof chunk.text === "string") {
            if (chunk.text.includes("<!-- dsh:busy -->") || chunk.text.includes("[DSH_SERVER_BUSY]")) {
              busy = true;
            }
          }
        }
        return { turn: prev.turn, busy, modelHint };
      },
      publication() {
        return "immediate";
      },
      buildLocationData(context, scope) {
        if (scope !== "turn" || !context.state) return null;
        return {
          kind: "turn",
          turn: context.state.turn,
          key: "busy-status",
          value: context.state,
        };
      },
    };

    const EMPTY_MODEL_STATE = { current: null };

    /**
     * Dock component mounted in `conversation.input.dock`.
     */
    function BusyBannerDock(props) {
      const { useSession, modelStore, t } = props;
      const snapshot = useSession((s) => s);

      const subscribeModel = (fn) => (modelStore && typeof modelStore.subscribe === "function"
        ? modelStore.subscribe(fn)
        : () => {});
      const getModelSnapshot = () => (modelStore && typeof modelStore.getSnapshot === "function"
        ? modelStore.getSnapshot()
        : EMPTY_MODEL_STATE);

      const modelState = useSyncExternalStore(subscribeModel, getModelSnapshot);
      const busyInfo = deriveSessionBusyState(snapshot);

      // Active model selection: prefer live ModelDirectory selection, fallback to last message provenance.
      const activeSelection = (modelState && modelState.current) || busyInfo.modelHint || null;
      const publicModelActive = isPublicModel(activeSelection);
      const modelIdKey = activeSelection
        ? String(activeSelection.provider || "") + "/" + String(activeSelection.model || "")
        : "default";

      const [dismissedAt, setDismissedAt] = useState(() => readDismissedAt(modelIdKey));

      // Rule 4: When user switches to a public model (DeepSeek, Kimi, etc.),
      // immediately hide banner AND clear the dismissed record so switching back
      // to the self-hosted model will re-notify if still busy.
      useEffect(() => {
        if (publicModelActive) {
          clearDismissedAt(modelIdKey);
          setDismissedAt(null);
        } else {
          setDismissedAt(readDismissedAt(modelIdKey));
        }
      }, [publicModelActive, modelIdKey]);

      // Rule 6: When the self-hosted model recovers (a completed response is no longer busy),
      // clear the dismissed record so the next peak period will notify normally.
      useEffect(() => {
        if (!publicModelActive && !busyInfo.busy && busyInfo.turn !== null) {
          clearDismissedAt(modelIdKey);
          setDismissedAt(null);
        }
      }, [publicModelActive, busyInfo.busy, busyInfo.turn, modelIdKey]);

      if (publicModelActive) return null;
      if (!busyInfo.busy) return null;
      if (isWithinCooldown(dismissedAt, Date.now())) return null;

      const handleDismiss = () => {
        const now = Date.now();
        writeDismissedAt(modelIdKey, now);
        setDismissedAt(now);
      };

      return h("div", {
        className: "dsh-bn-dock",
        "data-busy-notifier": "",
        role: "status",
        "aria-live": "polite",
      },
        h("div", { className: "dsh-bn-bar" },
          h("span", { className: "dsh-bn-icon", "aria-hidden": "true" }, "!"),
          h("div", { className: "dsh-bn-content" },
            h("span", { className: "dsh-bn-title" }, t("banner.title")),
            h("span", { className: "dsh-bn-desc" }, t("banner.desc"))),
          h("button", {
            type: "button",
            className: "dsh-bn-close",
            "aria-label": t("banner.close"),
            title: t("banner.close"),
            onClick: handleDismiss,
          }, "×")));
    }

    /**
     * Optional subtle badge at the tail of the degraded turn (`conversation.chat.turnTail`).
     */
    function selectBusyTurnTail(owner) {
      const turn = owner && owner.turn;
      if (!turn || !turn.data || typeof turn.data.get !== "function") return null;
      const status = turn.data.get("busy-status");
      if (!status || !status.busy) return null;
      return status;
    }

    function BusyTurnTailBadge(props) {
      const { t } = props;
      return h("div", { className: "dsh-bn-tail", "data-busy-turn-tail": "" },
        t("tail.badge"));
    }

    function apply(ctx) {
      ctx.effect(installStyle, "busy-notifier: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "busy-notifier: dictionaries");

      if (ctx.conversationEvents && typeof ctx.conversationEvents.register === "function") {
        ctx.conversationEvents.register(busyTurnDefinition);
      }

      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "busy-notifier",
          order: -10,
          locale: NS,
          inject: (sessionId) => {
            let modelStore = null;
            try {
              if (ctx.modelDirectories && typeof ctx.modelDirectories.directoryFor === "function") {
                modelStore = ctx.modelDirectories.directoryFor(sessionId).store;
              }
            } catch (_e) {
              modelStore = null;
            }
            return { modelStore: modelStore };
          },
        },
        BusyBannerDock,
      ));

      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
        {
          name: "conversation.chat.turnTail",
          select: selectBusyTurnTail,
          priority: 10,
          locale: NS,
        },
        BusyTurnTailBadge,
      ));
    }

    exports.inject = ["slots", "locale", "conversationEvents"];
    exports.apply = apply;
    exports._internal = {
      CONFIG,
      isPublicModel,
      inspectObjectForBusyFlag,
      deriveSessionBusyState,
      busyTurnDefinition,
      clearDismissedAt,
      readDismissedAt,
      writeDismissedAt,
    };
    return module.exports;
  },
});
