"use client";

/**
 * Opt-in auditory and visual alerts for security-critical telemetry (issue #90).
 *
 * An operator watching a console in an operations center cannot stare at the
 * feed and also watch the agent's traffic, so a block that lands while nobody
 * is looking goes unnoticed. This module turns a security-critical event into
 * a chime and a desktop notification — and nothing else.
 *
 * Three decisions shape it:
 *
 *   - **Opt-in, both ways.** Sound that fires unprompted is a false-alarm
 *     machine, and the Notification permission prompt appears before the user
 *     has any reason to grant it. Both channels default to off, and the desktop
 *     channel is inert until the browser has actually granted permission.
 *   - **Synthesised tones, no audio files.** A <200 ms two-beep chime built
 *     from oscillators costs nothing to load, cannot 404, and keeps the byte
 *     budget where it belongs. There is no asset pipeline to trust.
 *   - **The alert vocabulary lives here, not in the component.** Deciding that
 *     `blocked`/`frozen`/`policy_revoked` are the events worth interrupting an
 *     operator for is the security-relevant part of this feature, so it is a
 *     pure function with unit tests rather than an inline `if` in JSX.
 *
 * The audio context is created lazily and only ever started from a click:
 * browsers block an `AudioContext` that has not been resumed inside a user
 * activation, so a chime scheduled straight from a `useEffect` would silently
 * never sound. `unlock()` is the handler wired to the toggle button, and
 * `play()` before that returns a reason rather than pretending to have made
 * noise.
 */
import type { GuardEvent } from "stellar-agent-guard-sdk";

export const ALERT_SETTINGS_STORAGE_KEY = "stellar-agent-guard-dashboard.alerts.v1";

export interface AlertSettings {
  /** The Web Audio chime channel. */
  audio: boolean;
  /** The browser Notification channel. */
  desktop: boolean;
  /** Master gain for the chime, 0..1. */
  volume: number;
}

/** Both channels off: an operator has to ask to be interrupted. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  audio: false,
  desktop: false,
  volume: 0.4,
};

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;

/**
 * The two-beep chime. 80 ms on, 30 ms of silence, 80 ms on: 190 ms end to
 * end, which is short enough to be an interrupt rather than a jingle and long
 * enough to be unmistakable. `MAX_ALERT_AUDIO_MS` is the ceiling the unit test
 * holds this against, so a later edit that lengthens the pattern fails loudly.
 */
export const BEEP_DURATION_MS = 80;
export const BEEP_GAP_MS = 30;
export const BEEP_COUNT = 2;
export const BEEP_FREQUENCIES_HZ = [880, 1175] as const;
export const MAX_ALERT_AUDIO_MS = 200;

export interface AlertTone {
  frequencyHz: number;
  /** Offset from the start of the chime. */
  startMs: number;
  durationMs: number;
}

/** The oscillator schedule for one chime, in milliseconds. */
export function alertTonePlan(): AlertTone[] {
  const tones: AlertTone[] = [];
  for (let index = 0; index < BEEP_COUNT; index += 1) {
    tones.push({
      frequencyHz: BEEP_FREQUENCIES_HZ[index % BEEP_FREQUENCIES_HZ.length]!,
      startMs: index * (BEEP_DURATION_MS + BEEP_GAP_MS),
      durationMs: BEEP_DURATION_MS,
    });
  }
  return tones;
}

/** Wall-clock length of the chime, including the gap between beeps. */
export function alertPlanDurationMs(plan: readonly AlertTone[] = alertTonePlan()): number {
  const last = plan[plan.length - 1];
  if (!last) return 0;
  return last.startMs + last.durationMs;
}

/** 0..1 into perceptually usable gain, staying inside the safe range. */
export function gainForVolume(volume: number): number {
  const clamped = clampVolume(volume);
  // Equal-gain oscillators clip hard on laptop speakers; a square-root curve
  // keeps low settings audible without letting the top end distort.
  return Math.round(Math.sqrt(clamped) * 1000) / 1000;
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_ALERT_SETTINGS.volume;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume));
}

// ── Alert condition matching ───────────────────────────────────────────────

export type SecurityAlertReason = "blocked" | "frozen" | "policy_revoked";

/**
 * Which events deserve to interrupt an operator.
 *
 * `blocked` is the case the issue names: an unauthorized transfer or an
 * unexpected contract call the guard refused. `frozen` and `policy_revoked`
 * join it because both are someone changing the guardrails under the
 * operator's feet, and the feed is a polling view that a person mid-task will
 * not be reading. Everything else — heartbeats, allowed decisions, routine
 * policy installs from this very console — is noise, and alerting on it is how
 * an alert system gets muted.
 */
export function alertReasonFor(event: GuardEvent | null | undefined): SecurityAlertReason | null {
  if (!event) return null;
  if (event.kind === "auth_checked" && event.decision?.result === "blocked") return "blocked";
  if (event.kind === "frozen") return "frozen";
  if (event.kind === "policy_revoked") return "policy_revoked";
  return null;
}

export function isSecurityCritical(event: GuardEvent | null | undefined): boolean {
  return alertReasonFor(event) !== null;
}

/** Is any alert channel armed? */
export function alertsArmed(settings: AlertSettings): boolean {
  return settings.audio || settings.desktop;
}

/**
 * The longest data summary that goes into a deduplication key.
 *
 * The key is kept in a bounded set and, after a reload, in `sessionStorage`; an
 * unbounded `data` blob (a policy payload is a few kilobytes) would turn both
 * into a memory problem for a fact the identity fields already settle. A summary
 * is enough to keep two different events apart.
 */
const ALERT_KEY_DATA_LIMIT = 120;

/**
 * A stable identity for the alerting path.
 *
 * The SDK's own `id` is the right answer when it is there: it is derived from
 * the transaction hash and topic on the committed stream and from a content hash
 * on the diagnostic one, so the same event re-polled, re-queued, or re-delivered
 * by another tab keys identically. Two polls can also report the same event with
 * different ingestion timestamps, which is why `ledgerClosedAt` is deliberately
 * not part of any key here.
 *
 * `id` alone is not sufficient. The committed-stream format is
 * `ledger:<txHash>:<topic>`, and one transaction can carry several guard
 * decisions with the same topic — so the decision and a summary of the body ride
 * alongside it. Without that, a second distinct refusal inside one transaction
 * would be silently swallowed, which is the failure mode #313 warns about.
 *
 * When `id` is absent (an event built by an older SDK path, or a hand-made one
 * in a test), the composed field fallback keys the same way, and `createAlertTracker`
 * keeps it bounded either way.
 */
export function alertEventKey(event: GuardEvent): string {
  const identity =
    typeof event.id === "string" && event.id !== ""
      ? `id:${event.id}`
      : `fields:${[
          event.kind,
          event.topic,
          event.source,
          event.transactionHash ?? "-",
          event.ledger ?? "-",
        ].join("|")}`;
  const decision = event.decision
    ? `${event.decision.result}/${event.decision.reason ?? "-"}`
    : "-";
  return `${identity}|${decision}|${summarizeAlertData(event.data)}`;
}

/**
 * The event body, reduced to something safe to key on.
 *
 * `bigint` is the reason this is not a bare `JSON.stringify`: the guard's
 * amounts are stroops and arrive as `bigint`, which `JSON.stringify` *throws*
 * on. A throw inside the alerting effect would take the chime down for every
 * subsequent event — the one moment an operator most needs it.
 */
function summarizeAlertData(data: unknown): string {
  if (data === null || data === undefined) return "-";
  let text: string;
  try {
    text = JSON.stringify(data, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    text = String(data);
  }
  if (text === undefined) text = String(data);
  return text.length > ALERT_KEY_DATA_LIMIT ? `${text.slice(0, ALERT_KEY_DATA_LIMIT)}…` : text;
}

/** The identities a tracker has already alerted on, oldest first. */
export type AlertIdentity = string;

/**
 * The events this tab has not alerted on yet.
 *
 * Bounded so a console left open for a week cannot grow the set without limit;
 * the feed itself is capped at 250 events, so a few hundred keys is more
 * history than any single poll can revisit.
 *
 * `initialKeys` is what survives a page reload: the same feed re-primes from the
 * ledger history, and without a carried-over record every old refusal chimes
 * again the moment the tab is refreshed. The caller loads them for the *current*
 * scope (see `loadAlertDedupe`), so switching network or watched-guard set
 * hands the tracker an empty record instead of another scope's history.
 */
export function createAlertTracker(
  limit = 500,
  initialKeys: readonly AlertIdentity[] = [],
): {
  unseen(events: readonly GuardEvent[]): GuardEvent[];
  reset(): void;
  keys(): AlertIdentity[];
  readonly size: number;
} {
  const seen = new Set<string>(initialKeys.slice(-Math.max(0, limit)));
  return {
    unseen(events) {
      const fresh: GuardEvent[] = [];
      for (const event of events) {
        const key = alertEventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > limit) {
          const oldest = seen.values().next().value;
          if (typeof oldest === "string") seen.delete(oldest);
        }
        fresh.push(event);
      }
      return fresh;
    },
    reset() {
      seen.clear();
    },
    keys() {
      return [...seen];
    },
    get size() {
      return seen.size;
    },
  };
}

// ── Deduplication scope and its reload record ──────────────────────────────

/**
 * What "the same alerts" means, so a change of scope can invalidate the record.
 *
 * Event identities are only comparable within one network and one watched guard
 * set: a testnet refusal and a pubnet refusal can carry the same transaction
 * hash shape, and an operator who has just switched which guards they tail is
 * looking at a different stream. #313 asks for exactly this reset, and the
 * dashboard already scopes per-guard state the same way (`guardScoped.ts`).
 */
export interface AlertDedupeScope {
  network: string;
  /** The guard addresses whose events this tab is alerting on, in any order. */
  guards: readonly string[];
}

export const ALERT_DEDUPE_STORAGE_KEY = "stellar-agent-guard-dashboard.alertDedupe.v1";

/** How many identities are carried across a reload — the tracker's own bound. */
export const ALERT_DEDUPE_PERSIST_LIMIT = 500;

/** Order-insensitive and de-duplicated, so re-selecting the same set keeps the record. */
export function alertDedupeScopeKey(scope: AlertDedupeScope): string {
  const guards = [...new Set(scope.guards)].sort().join(",");
  return `${scope.network}|${guards}`;
}

const storedDedupe = (value: unknown): { scope?: unknown; keys?: unknown } | null => {
  if (typeof value !== "object" || value === null) return null;
  return value as { scope?: unknown; keys?: unknown };
};

/** The persisted identities for `scope`, or none when the record is not for it. */
export function loadAlertDedupe(
  scope: AlertDedupeScope,
  storage?: StorageLike | null,
): AlertIdentity[] {
  const store = storage === undefined ? defaultDedupeStorage() : storage;
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(ALERT_DEDUPE_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = storedDedupe(JSON.parse(raw) as unknown);
    if (!parsed || parsed.scope !== alertDedupeScopeKey(scope)) return [];
    if (!Array.isArray(parsed.keys)) return [];
    return parsed.keys
      .filter((key): key is string => typeof key === "string")
      .slice(-ALERT_DEDUPE_PERSIST_LIMIT);
  } catch {
    // A corrupt record is a missed dedupe, never a broken panel.
    return [];
  }
}

/** Remember the identities for `scope`, best-effort, for the next reload of this tab. */
export function saveAlertDedupe(
  scope: AlertDedupeScope,
  keys: readonly AlertIdentity[],
  storage?: StorageLike | null,
): void {
  const store = storage === undefined ? defaultDedupeStorage() : storage;
  if (!store) return;
  try {
    store.setItem(
      ALERT_DEDUPE_STORAGE_KEY,
      JSON.stringify({
        scope: alertDedupeScopeKey(scope),
        keys: keys.slice(-ALERT_DEDUPE_PERSIST_LIMIT),
      }),
    );
  } catch {
    // Private mode or quota: the dedupe stays in memory for this session.
  }
}

/**
 * `sessionStorage`, not `localStorage`.
 *
 * The record answers "has *this tab* already chimed for this event?" — a reload
 * of the same tab should not re-alert its own history, while a second tab on the
 * wall monitor is a separate operator watching it and starts clean.
 */
function defaultDedupeStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    const scope = window.sessionStorage;
    if (!scope) return null;
    return {
      getItem: (key) => scope.getItem(key),
      setItem: (key, value) => scope.setItem(key, value),
    };
  } catch {
    return null;
  }
}

// ── Notification payload ───────────────────────────────────────────────────

export interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  requireInteraction: boolean;
}

/**
 * The desktop notification for one event.
 *
 * `tag` is what makes repeated blocks collapse into a single notification
 * rather than stacking a pile of identical ones, and `requireInteraction`
 * keeps a security alert on screen until the operator acknowledges it — a
 * blocked unauthorized transfer is not a message that should time out.
 *
 * Returns null for anything that is not security-critical, so a caller cannot
 * accidentally notify on a heartbeat.
 */
export function buildNotificationPayload(
  event: GuardEvent,
  guard: string,
): NotificationPayload | null {
  const reason = alertReasonFor(event);
  if (!reason) return null;
  const detail =
    reason === "blocked"
      ? `The guard refused a call${event.decision?.reason ? ` (${event.decision.reason})` : ""}.`
      : reason === "frozen"
        ? "The account was frozen by an admin."
        : "A policy was revoked.";
  return {
    title: `Agent Guard: ${notificationSubject(reason)}`,
    body: `${detail} Guard ${shortForNotification(guard)}.`,
    tag: `agent-guard-${reason}`,
    requireInteraction: true,
  };
}

export function notificationSubject(reason: SecurityAlertReason): string {
  switch (reason) {
    case "blocked":
      return "transfer blocked";
    case "frozen":
      return "account frozen";
    case "policy_revoked":
      return "policy revoked";
  }
}

function shortForNotification(guard: string): string {
  if (guard.length <= 13) return guard;
  return `${guard.slice(0, 6)}…${guard.slice(-4)}`;
}

// ── Notification permission plumbing ───────────────────────────────────────

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

/**
 * The browser's `Notification` surface, as far as this module needs it.
 *
 * A `class` in the type position would force every test to construct one;
 * `show()` takes the shape instead, so a fake is a plain object literal.
 */
export interface NotificationApi {
  readonly permission: string;
  requestPermission(): Promise<string>;
  show(title: string, options: NotificationPayload): unknown;
}

/** Read the live `window.Notification`, or null where it does not exist (Safari, Node). */
export function readBrowserNotificationApi(win?: unknown): NotificationApi | null {
  const scope = (win ?? (typeof window === "undefined" ? null : window)) as {
    Notification?: unknown;
    webkitNotifications?: unknown;
  } | null;
  if (!scope) return null;
  const ctor = scope.Notification;
  if (typeof ctor !== "function") return null;
  const notification = ctor as {
    permission?: string;
    requestPermission?: () => Promise<string> | void;
    new (title: string, options: Record<string, unknown>): unknown;
  };
  return {
    // A getter, not a captured string: `Notification.permission` is a live
    // static, and an operator who clicks Allow in this session changes it. A
    // snapshot taken at mount would keep reporting "not granted" — and keep
    // refusing deliveries the browser would now show — until the page reloads.
    get permission() {
      return typeof notification.permission === "string" ? notification.permission : "default";
    },
    requestPermission: async () => {
      const result = notification.requestPermission?.();
      if (result && typeof (result as Promise<string>).then === "function") {
        return await (result as Promise<string>);
      }
      // Safari's prefixed API used a callback instead of a promise. Treat a
      // call that resolves to nothing as a grant attempt whose outcome the
      // caller re-reads from `permission`.
      return notification.permission ?? "default";
    },
    show: (title, options) => new notification(title, { ...options }),
  };
}

/** Map whatever the browser reports onto the four states this UI renders. */
export function notificationPermissionState(
  api: NotificationApi | null,
): NotificationPermissionState {
  if (!api) return "unsupported";
  return normalisePermission(api.permission);
}

function normalisePermission(value: string | undefined): NotificationPermissionState {
  switch (value) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    default:
      return "default";
  }
}

/** Ask for permission, and report the browser's answer rather than assuming it. */
export async function requestNotificationPermission(
  api: NotificationApi | null,
): Promise<NotificationPermissionState> {
  if (!api) return "unsupported";
  try {
    return normalisePermission(await api.requestPermission());
  } catch {
    return normalisePermission(api.permission);
  }
}

export interface NotificationDelivery {
  delivered: boolean;
  reason: "delivered" | "not-allowed" | "unavailable" | "failed";
}

/**
 * Show a notification, refusing to try when permission was never given.
 *
 * The `not-allowed` branch matters for the UI: it is the difference between
 * "the operator has to click Allow once" and "the operator has to go into
 * browser settings", and a silent failure cannot tell them apart.
 */
export function deliverNotification(
  payload: NotificationPayload | null,
  api: NotificationApi | null,
): NotificationDelivery {
  if (!payload) return { delivered: false, reason: "unavailable" };
  if (!api) return { delivered: false, reason: "unavailable" };
  if (api.permission !== "granted") return { delivered: false, reason: "not-allowed" };
  try {
    api.show(payload.title, payload);
    return { delivered: true, reason: "delivered" };
  } catch {
    return { delivered: false, reason: "failed" };
  }
}

// ── Effective channel state (#314) ─────────────────────────────────────────

/**
 * Whether the desktop channel would actually deliver, as the operator reads it.
 *
 * Three different things get conflated when an alert panel only has a toggle:
 * what the operator asked for, what the browser permits, and what the last
 * delivery did. An enabled switch beside a denied permission is a lie of
 * omission — it implies protection the tab cannot provide — so the panel renders
 * this value rather than the preference alone.
 */
export type DesktopEffective =
  /** The operator has not turned the channel on. */
  | "off"
  /** This browser offers no notifications at all (Safari, some webviews, SSR). */
  | "unsupported"
  /** The browser has denied permission; only site settings can change that. */
  | "blocked-by-browser"
  /** Turned on, permission not yet given — the prompt is waiting on the operator. */
  | "awaiting-permission"
  /** Granted, and this tab has not had to show one yet. */
  | "ready"
  /** Granted, but the last delivery did not go through. */
  | "failing"
  /** Granted, and the last delivery went through. */
  | "delivering";

export type AudioEffective = "off" | "unsupported" | "needs-unlock" | "ready";

/**
 * The desktop channel's effective state.
 *
 * Permission outranks the delivery record, because a delivery failure recorded
 * before permission changed describes the old permission, not the new one.
 * "Granted and nothing has gone wrong" is *not* enough to claim delivery: the
 * honest reading of granted-with-no-attempt is `ready`, or a reload would report
 * an alert that never happened.
 */
export function desktopEffective(
  preference: boolean,
  permission: NotificationPermissionState,
  lastDelivery: NotificationDelivery | null,
): DesktopEffective {
  if (!preference) return "off";
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "blocked-by-browser";
  if (permission !== "granted") return "awaiting-permission";
  if (!lastDelivery) return "ready";
  return lastDelivery.delivered ? "delivering" : "failing";
}

/**
 * The audio channel's effective state, from the last play report the tab saw.
 *
 * No report at all means the chime has not been asked to sound in this tab —
 * which is exactly the state right after a reload, when the stored preference
 * says "on" but the browser still needs a gesture before it will play anything.
 */
export function audioEffective(
  preference: boolean,
  lastPlay: AudioPlayReport | null,
): AudioEffective {
  if (!preference) return "off";
  if (lastPlay?.reason === "unsupported") return "unsupported";
  if (!lastPlay || !lastPlay.played) return "needs-unlock";
  return "ready";
}

/** One honest sentence per state, including what to do about it. */
export function describeDesktopEffective(state: DesktopEffective): string {
  switch (state) {
    case "off":
      return "Desktop notifications are off.";
    case "unsupported":
      return "Desktop notifications are unavailable: this browser offers no Notification API.";
    case "blocked-by-browser":
      return "Desktop notifications are blocked by the browser for this site. Re-allow them in site settings — the switch here cannot undo that.";
    case "awaiting-permission":
      return "Desktop notifications are on but not yet permitted; the browser has not granted permission.";
    case "ready":
      return "Desktop notifications are permitted; nothing has needed to alert since this tab opened.";
    case "failing":
      return "Desktop notifications are permitted but the last alert could not be shown.";
    case "delivering":
      return "Desktop notifications are permitted and delivering.";
  }
}

export function describeAudioEffective(state: AudioEffective): string {
  switch (state) {
    case "off":
      return "The chime is off.";
    case "unsupported":
      return "The chime is unavailable: this browser has no Web Audio.";
    case "needs-unlock":
      return "The chime is on but has not sounded — the browser needs a click on this page before audio can start.";
    case "ready":
      return "The chime is ready.";
  }
}

/**
 * Why a delivery did not happen, in the operator's terms.
 *
 * The three refusals are different fixes: `not-allowed` is one click on the
 * prompt, `unavailable` is a browser without the API, `failed` is the
 * constructor throwing (enterprise policy, a crashed service worker). Collapsing
 * them into "failed" is what #314 exists to stop.
 */
export function describeNotificationDelivery(delivery: NotificationDelivery): string {
  switch (delivery.reason) {
    case "delivered":
      return "Notification shown.";
    case "not-allowed":
      return "Notification not shown: permission was not granted.";
    case "unavailable":
      return "Notification not shown: this browser cannot display one.";
    case "failed":
      return "Notification not shown: the browser refused to create it.";
  }
}

// ── The chime ──────────────────────────────────────────────────────────────

export interface OscillatorLike {
  type: string;
  readonly frequency: { value: number };
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike {
  readonly gain: { value: number };
  connect(destination: unknown): unknown;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state?: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume?(): Promise<unknown>;
  close?(): Promise<unknown>;
}

/** Why audio is not playing yet, which decides what the panel offers next. */
export type AudioAlerterStatus = "idle" | "ready" | "unsupported";

export type AudioUnlockReason = "ready" | "unsupported" | "not-unlocked";

export interface AudioPlayReport {
  played: boolean;
  reason: AudioUnlockReason | "played";
  beeps: number;
  durationMs: number;
}

/**
 * Owns one `AudioContext` and the autoplay constraint around it.
 *
 * `unlock()` is the only way in: it creates and resumes the context from
 * inside a click handler, which is the sole moment the browser allows audio to
 * begin. Everything the class does afterwards is scheduling against the
 * context's own clock, which is why `play()` never needs a gesture of its own
 * and can be driven by a polled feed.
 */
export class AudioAlerter {
  private readonly contextFactory: (() => AudioContextLike | null) | null;
  private context: AudioContextLike | null = null;
  private status: AudioAlerterStatus = "idle";
  private volume: number;

  constructor(options: {
    contextFactory: (() => AudioContextLike | null) | null;
    volume?: number;
  }) {
    this.contextFactory = options.contextFactory;
    this.volume = clampVolume(options.volume ?? DEFAULT_ALERT_SETTINGS.volume);
  }

  /** Default to the browser's own constructor, injected so tests never touch audio. */
  static forBrowser(settings?: { volume?: number }): AudioAlerter {
    const factory: (() => AudioContextLike | null) | null =
      typeof window === "undefined"
        ? null
        : () => {
            const scope = window as unknown as {
              AudioContext?: new () => AudioContextLike;
              webkitAudioContext?: new () => AudioContextLike;
            };
            const ctor = scope.AudioContext ?? scope.webkitAudioContext;
            return ctor ? new ctor() : null;
          };
    return new AudioAlerter({
      contextFactory: factory,
      ...(settings?.volume === undefined ? {} : { volume: settings.volume }),
    });
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
  }

  get unlocked(): boolean {
    return this.status === "ready";
  }

  /** Call from a click. Returns whether audio is now available. */
  unlock(): AudioUnlockReason {
    if (this.status === "unsupported") return "unsupported";
    if (!this.contextFactory) {
      this.status = "unsupported";
      return "unsupported";
    }
    if (!this.context) {
      try {
        const created = this.contextFactory();
        if (!created) {
          this.status = "unsupported";
          return "unsupported";
        }
        this.context = created;
      } catch {
        // A blocked constructor is permanent for this page; say so once, clearly.
        this.context = null;
        this.status = "unsupported";
        return "unsupported";
      }
    }
    void this.context.resume?.();
    this.status = "ready";
    return "ready";
  }

  /** Schedule one chime. Silently refuses until `unlock()` has run. */
  play(): AudioPlayReport {
    const plan = alertTonePlan();
    const durationMs = alertPlanDurationMs(plan);
    if (this.status === "unsupported") {
      return { played: false, reason: "unsupported", beeps: 0, durationMs };
    }
    if (this.status !== "ready" || !this.context) {
      return { played: false, reason: "not-unlocked", beeps: 0, durationMs };
    }
    const context = this.context;

    void context.resume?.();
    const startedAt = context.currentTime;
    const gain = context.createGain();
    gain.gain.value = gainForVolume(this.volume);
    gain.connect(context.destination);
    for (const tone of plan) {
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = tone.frequencyHz;
      oscillator.connect(gain);
      const start = startedAt + tone.startMs / 1000;
      oscillator.start(start);
      oscillator.stop(start + tone.durationMs / 1000);
    }
    return { played: true, reason: "played", beeps: plan.length, durationMs };
  }

  close(): void {
    void this.context?.close?.();
    this.context = null;
    this.status = "idle";
  }
}

// ── Persistence ────────────────────────────────────────────────────────────

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The operator's saved alert settings, or the safe defaults. */
export function loadAlertSettings(storage?: StorageLike | null): AlertSettings {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return { ...DEFAULT_ALERT_SETTINGS };
  let raw: string | null = null;
  try {
    raw = store.getItem(ALERT_SETTINGS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_ALERT_SETTINGS };
  }
  if (!raw) return { ...DEFAULT_ALERT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<AlertSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_ALERT_SETTINGS };
    return {
      audio: parsed.audio === true,
      desktop: parsed.desktop === true,
      volume: clampVolume(
        typeof parsed.volume === "number" ? parsed.volume : DEFAULT_ALERT_SETTINGS.volume,
      ),
    };
  } catch {
    // Corrupt storage is a lost preference, not a reason to break the panel.
    return { ...DEFAULT_ALERT_SETTINGS };
  }
}

export function saveAlertSettings(settings: AlertSettings, storage?: StorageLike | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(
      ALERT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...settings, volume: clampVolume(settings.volume) }),
    );
  } catch {
    // A private-mode write only loses the preference for this session.
  }
}
