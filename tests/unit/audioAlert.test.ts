import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  AudioAlerter,
  ALERT_DEDUPE_PERSIST_LIMIT,
  ALERT_DEDUPE_STORAGE_KEY,
  BEEP_COUNT,
  DEFAULT_ALERT_SETTINGS,
  MAX_ALERT_AUDIO_MS,
  ALERT_SETTINGS_STORAGE_KEY,
  alertDedupeScopeKey,
  alertEventKey,
  alertPlanDurationMs,
  alertReasonFor,
  alertTonePlan,
  alertsArmed,
  audioEffective,
  buildNotificationPayload,
  clampVolume,
  createAlertTracker,
  deliverNotification,
  desktopEffective,
  describeAudioEffective,
  describeDesktopEffective,
  describeNotificationDelivery,
  gainForVolume,
  isSecurityCritical,
  loadAlertDedupe,
  loadAlertSettings,
  notificationPermissionState,
  readBrowserNotificationApi,
  requestNotificationPermission,
  saveAlertDedupe,
  saveAlertSettings,
  type AudioContextLike,
  type AudioEffective,
  type DesktopEffective,
  type GainLike,
  type NotificationApi,
  type NotificationDelivery,
  type OscillatorLike,
} from "../../lib/guard/audioAlert.ts";
import { withIdentity } from "../mocks/eventFixtures.ts";

/**
 * Alerting is the one feature here that interrupts a human being, so the tests
 * are strict about the two properties that make it tolerable: the chime is
 * short, and it only ever sounds for an event the guard actually refused or an
 * admin actually changed the rules.
 */

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    contractId: null,
    ledger: 100,
    ledgerClosedAt: "2026-09-25T12:00:00.000Z",
    transactionHash: "a".repeat(64),
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    ...overrides,
  });
}

// ── A fake AudioContext that records exactly what was scheduled ────────────

interface FakeOscillator extends OscillatorLike {
  readonly startedAt: (number | undefined)[];
  readonly stoppedAt: (number | undefined)[];
}

function createFakeAudioContext(startOfTime = 1000) {
  const oscillators: FakeOscillator[] = [];
  const gains: GainLike[] = [];
  let resumes = 0;
  let closes = 0;

  const context: AudioContextLike = {
    currentTime: startOfTime,
    destination: { id: "destination" },
    state: "running",
    createOscillator() {
      const startedAt: (number | undefined)[] = [];
      const stoppedAt: (number | undefined)[] = [];
      const oscillator: FakeOscillator = {
        type: "sine",
        frequency: { value: 440 },
        startedAt,
        stoppedAt,
        connect: () => oscillator,
        start: (when) => void startedAt.push(when),
        stop: (when) => void stoppedAt.push(when),
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      const gain: GainLike = { gain: { value: 1 }, connect: () => ({}) };
      gains.push(gain);
      return gain;
    },
    resume: async () => {
      resumes += 1;
      return undefined;
    },
    close: async () => {
      closes += 1;
      return undefined;
    },
  };

  return {
    context,
    oscillators,
    gains,
    resumes: () => resumes,
    closes: () => closes,
  };
}

function fakeNotificationApi(
  permission: string,
  options: { requestPermission?: () => Promise<string>; show?: NotificationApi["show"] } = {},
): NotificationApi & { shown: { title: string; options: unknown }[] } {
  const shown: { title: string; options: unknown }[] = [];
  return {
    permission,
    requestPermission: options.requestPermission ?? (async () => permission),
    show:
      options.show ??
      ((title, payload) => {
        shown.push({ title, options: payload });
        return {};
      }),
    shown,
  };
}

describe("alert condition matching", () => {
  it("sounds for a blocked decision, which is the case the operator must not miss", () => {
    assert.equal(
      alertReasonFor(
        event({
          decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
        }),
      ),
      "blocked",
    );
    assert.equal(
      isSecurityCritical(
        event({ decision: { result: "blocked", reason: null, source: "ledger" } }),
      ),
      true,
    );
  });

  it("treats an admin freeze and a revoked policy as security-critical", () => {
    assert.equal(
      alertReasonFor(event({ kind: "frozen", topic: "event_frozen", decision: null })),
      "frozen",
    );
    assert.equal(
      alertReasonFor(
        event({ kind: "policy_revoked", topic: "event_policy_revoked", decision: null }),
      ),
      "policy_revoked",
    );
  });

  it("stays quiet for routine events, which is what keeps the alert unmuted", () => {
    assert.equal(alertReasonFor(event()), null);
    assert.equal(
      alertReasonFor(event({ kind: "heartbeat", topic: "event_heartbeat", decision: null })),
      null,
    );
    assert.equal(
      alertReasonFor(event({ kind: "policy_set", topic: "event_policy_set", decision: null })),
      null,
    );
    assert.equal(
      alertReasonFor(event({ kind: "unfrozen", topic: "event_unfrozen", decision: null })),
      null,
    );
    assert.equal(
      alertReasonFor(event({ kind: "initialized", topic: "event_initialized", decision: null })),
      null,
    );
  });

  it("tolerates a missing event rather than inventing an alert", () => {
    assert.equal(alertReasonFor(null), null);
    assert.equal(alertReasonFor(undefined), null);
    assert.equal(
      alertReasonFor(event({ decision: null })),
      null,
      "an auth_checked event with no decoded decision says nothing about a block",
    );
  });

  it("is armed only when a channel is on, and both default to off", () => {
    assert.deepEqual(DEFAULT_ALERT_SETTINGS, { audio: false, desktop: false, volume: 0.4 });
    assert.equal(alertsArmed(DEFAULT_ALERT_SETTINGS), false);
    assert.equal(alertsArmed({ ...DEFAULT_ALERT_SETTINGS, audio: true }), true);
    assert.equal(alertsArmed({ ...DEFAULT_ALERT_SETTINGS, desktop: true }), true);
  });
});

describe("the chime", () => {
  it("is two beeps totalling under the 200ms ceiling", () => {
    const plan = alertTonePlan();
    assert.equal(plan.length, BEEP_COUNT);
    assert.equal(plan[0]!.startMs, 0);
    assert.ok(
      plan[1]!.startMs > plan[0]!.startMs + plan[0]!.durationMs,
      "the beeps are separated by silence",
    );
    assert.ok(
      alertPlanDurationMs(plan) < MAX_ALERT_AUDIO_MS,
      `a ${alertPlanDurationMs(plan)}ms chime is an interrupt, not a jingle`,
    );
    for (const tone of plan) assert.equal(tone.durationMs, 80);
  });

  it("never sounds before the first user gesture, per the autoplay policy", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 0.5 });

    const refused = alerter.play();
    assert.equal(refused.played, false);
    assert.equal(refused.reason, "not-unlocked");
    assert.equal(fake.oscillators.length, 0, "no oscillator may exist before a gesture");
    assert.equal(alerter.unlocked, false);

    assert.equal(alerter.unlock(), "ready");
    assert.equal(alerter.unlocked, true);
    assert.equal(fake.resumes(), 1, "unlocking is what resumes the context");
  });

  it("schedules one oscillator per beep against the context clock when it plays", () => {
    const fake = createFakeAudioContext(42);
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 0.5 });
    alerter.unlock();

    const report = alerter.play();
    assert.deepEqual(
      {
        played: report.played,
        reason: report.reason,
        beeps: report.beeps,
        durationMs: report.durationMs,
      },
      { played: true, reason: "played", beeps: 2, durationMs: alertPlanDurationMs() },
    );
    assert.equal(fake.oscillators.length, 2);
    const tones = alertTonePlan();
    fake.oscillators.forEach((oscillator, index) => {
      assert.equal(oscillator.frequency.value, tones[index]!.frequencyHz);
      assert.equal(oscillator.startedAt[0], 42 + tones[index]!.startMs / 1000);
      assert.equal(
        oscillator.stoppedAt[0],
        42 + (tones[index]!.startMs + tones[index]!.durationMs) / 1000,
      );
    });
  });

  it("routes every beep through a single gain node set from the volume", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 1 });
    alerter.unlock();
    alerter.play();
    assert.equal(
      fake.gains.length,
      1,
      "one shared gain, so volume changes apply to the whole chime",
    );
    assert.equal(fake.gains[0]!.gain.value, 1);

    alerter.setVolume(0);
    fake.gains.length = 0;
    alerter.play();
    assert.equal(fake.gains[0]!.gain.value, 0);
  });

  it("reports unsupported instead of throwing where there is no Web Audio", () => {
    const alerter = new AudioAlerter({ contextFactory: null });
    assert.equal(alerter.unlock(), "unsupported");
    assert.equal(alerter.play().played, false);
    assert.equal(alerter.play().reason, "unsupported");
  });

  it("survives a constructor that throws, which is what a locked-down browser does", () => {
    const alerter = new AudioAlerter({
      contextFactory: () => {
        throw new Error("AudioContext construction blocked");
      },
    });
    assert.equal(alerter.unlock(), "unsupported");
    assert.equal(alerter.play().reason, "unsupported");
  });

  it("keeps the volume inside a safe range, including a NaN from a form field", () => {
    assert.equal(clampVolume(-3), 0);
    assert.equal(clampVolume(7), 1);
    assert.equal(clampVolume(Number.NaN), DEFAULT_ALERT_SETTINGS.volume);
    assert.equal(gainForVolume(1), 1);
    assert.equal(gainForVolume(0), 0);
    assert.ok(gainForVolume(0.25) > 0.25, "the curve favours audibility at low settings");
  });

  it("closes the context and forgets the gesture on shutdown", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context });
    alerter.unlock();
    alerter.close();
    assert.equal(fake.closes(), 1);
    assert.equal(alerter.unlocked, false);
    assert.equal(alerter.play().played, false);
  });
});

describe("notification payload generation", () => {
  const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

  it("names the refusal and the guard, so a notification on its own is actionable", () => {
    const payload = buildNotificationPayload(
      event({
        decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      }),
      GUARD,
    );
    assert.ok(payload);
    assert.equal(payload.title, "Agent Guard: transfer blocked");
    assert.match(payload.body, /refused a call \(per_tx_cap_exceeded\)/);
    assert.ok(
      payload.body.includes(GUARD.slice(0, 6)),
      "the guard is identified, not just described",
    );
    assert.equal(
      payload.tag,
      "agent-guard-blocked",
      "a stable tag collapses repeats into one notification",
    );
    assert.equal(payload.requireInteraction, true);
  });

  it("words an admin action differently from a refusal", () => {
    const frozen = buildNotificationPayload(event({ kind: "frozen", decision: null }), "CABC");
    const revoked = buildNotificationPayload(
      event({ kind: "policy_revoked", decision: null }),
      "CABC",
    );
    assert.equal(frozen?.title, "Agent Guard: account frozen");
    assert.match(frozen!.body, /frozen by an admin/);
    assert.equal(revoked?.title, "Agent Guard: policy revoked");
    assert.match(revoked!.body, /policy was revoked/i);
  });

  it("produces nothing for a non-critical event, so a caller cannot notify on a heartbeat", () => {
    assert.equal(
      buildNotificationPayload(event({ kind: "heartbeat", decision: null }), "CABC"),
      null,
    );
    assert.equal(buildNotificationPayload(event(), "CABC"), null);
  });
});

describe("notification permission and delivery", () => {
  it("reports unsupported where the browser has no Notification constructor", () => {
    assert.equal(notificationPermissionState(null), "unsupported");
    const delivery = deliverNotification(
      { title: "t", body: "b", tag: "g", requireInteraction: true },
      null,
    );
    assert.deepEqual(delivery, { delivered: false, reason: "unavailable" });
  });

  it("refuses to construct a notification the browser would not show", () => {
    const api = fakeNotificationApi("denied");
    assert.equal(notificationPermissionState(api), "denied");
    const delivery = deliverNotification(
      { title: "t", body: "b", tag: "g", requireInteraction: true },
      api,
    );
    assert.deepEqual(delivery, { delivered: false, reason: "not-allowed" });
    assert.equal(api.shown.length, 0, "an ungranted permission must not even attempt construction");
  });

  it("delivers once permission is granted, passing the payload through", () => {
    const api = fakeNotificationApi("granted");
    assert.equal(notificationPermissionState(api), "granted");
    const payload = {
      title: "Agent Guard: transfer blocked",
      body: "b",
      tag: "agent-guard-blocked",
      requireInteraction: true,
    };
    assert.deepEqual(deliverNotification(payload, api), { delivered: true, reason: "delivered" });
    assert.deepEqual(api.shown, [{ title: payload.title, options: payload }]);
  });

  it("maps a permission request onto the browser's answer", async () => {
    assert.equal(await requestNotificationPermission(fakeNotificationApi("granted")), "granted");
    assert.equal(
      await requestNotificationPermission(
        fakeNotificationApi("default", { requestPermission: async () => "denied" }),
      ),
      "denied",
    );
    assert.equal(
      await requestNotificationPermission(
        fakeNotificationApi("default", {
          requestPermission: async () => {
            throw new Error("prompt blocked");
          },
        }),
      ),
      "default",
      "a thrown prompt falls back to the permission the browser already reports",
    );
    assert.equal(await requestNotificationPermission(null), "unsupported");
  });

  it("reports a constructor that throws as a failed delivery", () => {
    const api = fakeNotificationApi("granted", {
      show: () => {
        throw new Error("notifications disabled by policy");
      },
    });
    assert.deepEqual(
      deliverNotification({ title: "t", body: "b", tag: "g", requireInteraction: true }, api),
      { delivered: false, reason: "failed" },
    );
  });

  it("re-reads the browser's permission rather than freezing it at mount (#314)", () => {
    class FakeNotification {
      static permission = "default";
      static readonly shown: { title: string; options: Record<string, unknown> }[] = [];
      constructor(title: string, options: Record<string, unknown>) {
        FakeNotification.shown.push({ title, options });
      }
    }

    const api = readBrowserNotificationApi({ Notification: FakeNotification });
    assert.ok(api);
    assert.equal(notificationPermissionState(api), "default");

    // The operator clicks Allow in the prompt. A snapshot taken at mount would
    // keep saying "not granted" — and keep refusing deliveries the browser
    // would now show — until the page reloaded.
    FakeNotification.permission = "granted";
    assert.equal(notificationPermissionState(api), "granted");
    assert.deepEqual(
      deliverNotification({ title: "t", body: "b", tag: "g", requireInteraction: true }, api),
      {
        delivered: true,
        reason: "delivered",
      },
    );
    assert.equal(FakeNotification.shown.length, 1);
  });
});

describe("not re-alerting on an event that was already announced", () => {
  it("reports each event once across repeated polls", () => {
    const tracker = createAlertTracker();
    const blocked = event({
      ledger: 7,
      decision: { result: "blocked", reason: "paused", source: "ledger" },
    });
    const allowed = event({ ledger: 8 });

    assert.deepEqual(
      tracker.unseen([blocked, allowed]).map((entry) => entry.ledger),
      [7, 8],
    );
    assert.deepEqual(tracker.unseen([blocked, allowed]), [], "the same rows must not chime twice");
    assert.equal(tracker.unseen([blocked]).length, 0);

    const later = event({ ledger: 9, transactionHash: "b".repeat(64) });
    assert.deepEqual(
      tracker.unseen([later, blocked]).map((entry) => entry.ledger),
      [9],
    );
  });

  it("keys on the decision, not only the topic", () => {
    const tracker = createAlertTracker();
    const first = event({
      ledger: 1,
      decision: { result: "allowed", reason: null, source: "ledger" },
    });
    const second = event({
      ledger: 1,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "ledger" },
    });
    assert.equal(tracker.unseen([first, second]).length, 2);
  });

  it("starts over on reset, which is what switching guards requires", () => {
    const tracker = createAlertTracker();
    const blocked = event({ decision: { result: "blocked", reason: "paused", source: "ledger" } });
    tracker.unseen([blocked]);
    assert.equal(tracker.unseen([blocked]).length, 0);
    tracker.reset();
    assert.equal(tracker.unseen([blocked]).length, 1);
    assert.equal(tracker.size, 1);
  });

  it("stays bounded so a console open for a week cannot grow without limit", () => {
    const tracker = createAlertTracker(3);
    for (let ledger = 0; ledger < 10; ledger += 1) {
      tracker.unseen([event({ ledger, transactionHash: `${ledger}`.padEnd(64, "0") })]);
    }
    assert.ok(tracker.size <= 3);
  });
});

/**
 * #313: what an alert is remembered under.
 *
 * The SDK's `id` is the stable answer when the feed carried one, but the
 * committed-stream format is `ledger:<txHash>:<topic>` and one transaction can
 * carry several guard decisions on the same topic. Keying on the id alone is the
 * failure this issue is about: the second refusal never chimes, and the operator
 * reads a silent console as an empty one.
 */
describe("alert identity (#313)", () => {
  const sharedId = "ledger:abc123:event_auth_checked";

  function blockedWith(overrides: Parameters<typeof event>[0] = {}) {
    return event({
      id: sharedId,
      transactionHash: "a".repeat(64),
      ledger: 5,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "ledger" },
      ...overrides,
    });
  }

  it("keeps two refusals that carry the same event id apart", () => {
    const tracker = createAlertTracker();
    const cap = blockedWith();
    const unauthorized = blockedWith({
      decision: { result: "blocked", reason: "unauthorized", source: "ledger" },
      data: { caller: "C" + "G".repeat(55) },
    });

    assert.equal(tracker.unseen([cap, unauthorized]).length, 2);
    assert.equal(
      tracker.unseen([cap, unauthorized]).length,
      0,
      "the same two rows must not chime a second time",
    );
  });

  it("keys on the body too, so one refusal per subject is one alert each", () => {
    const tracker = createAlertTracker();
    const first = blockedWith({ data: { subject: "GA" + "1".repeat(55) } });
    const second = blockedWith({ data: { subject: "GA" + "2".repeat(55) } });
    assert.notEqual(alertEventKey(first), alertEventKey(second));
    assert.equal(tracker.unseen([first, second]).length, 2);
  });

  it("uses the event's own fields when there is no id to trust", () => {
    const tracker = createAlertTracker();
    const first = event({ id: "", ledger: 41, transactionHash: "d".repeat(64) });
    const second = event({ id: "", ledger: 42, transactionHash: "e".repeat(64) });
    assert.notEqual(alertEventKey(first), alertEventKey(second));

    assert.deepEqual(
      tracker.unseen([first, second]).map((entry) => entry.ledger),
      [41, 42],
    );
    assert.deepEqual(tracker.unseen([first, second]), []);
  });

  it("tolerates a bigint amount instead of throwing on the whole feed", () => {
    // Stroops arrive as `bigint`, which `JSON.stringify` *throws* on. A throw
    // inside the alerting effect would silence every later event in the tab.
    const cap = event({ data: { cap: 9_223_372_036_854_775_807n } });
    assert.doesNotThrow(() => alertEventKey(cap));
    assert.notEqual(
      alertEventKey(cap),
      alertEventKey(event({ data: { cap: 9_223_372_036_854_775_806n } })),
    );
  });

  it("keeps the key bounded when the body is a policy payload", () => {
    const huge = event({ data: { blob: "x".repeat(20_000) } });
    assert.ok(alertEventKey(huge).length < 400, "keys go into a bounded set and into storage");

    // Truncation cannot swallow a distinct event, because the identity fields
    // still separate them: two bodies sharing a 120-character prefix with
    // different ids are two keys.
    const a = event({ id: "diag:aaa", data: { blob: "x".repeat(200) + "1" } });
    const b = event({ id: "diag:bbb", data: { blob: "x".repeat(200) + "2" } });
    assert.notEqual(alertEventKey(a), alertEventKey(b));
  });
});

/**
 * #313: the record behind the reload, and when it stops applying.
 *
 * `sessionStorage`, scoped to the network and the watched guard set: the question
 * the record answers is "has *this tab* already chimed?", so a refresh of the
 * same tab must stay quiet while a second tab on the wall monitor — a different
 * operator watching it — starts clean.
 */
describe("alert dedupe across a reload and across scopes (#313)", () => {
  const testnet = { network: "testnet", guards: ["GB", "GA"] };

  function createDedupeStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      raw: () => map.get(ALERT_DEDUPE_STORAGE_KEY) ?? null,
    };
  }

  it("carries the alerted identities over a reload", () => {
    const storage = createDedupeStorage();
    const tracker = createAlertTracker();
    const refusal = event({
      decision: { result: "blocked", reason: "paused", source: "ledger" },
      ledger: 77,
    });
    tracker.unseen([refusal]);
    saveAlertDedupe(testnet, tracker.keys(), storage);

    // A reload: a fresh tab reads the record into a fresh tracker.
    const reloaded = createAlertTracker(
      ALERT_DEDUPE_PERSIST_LIMIT,
      loadAlertDedupe(testnet, storage),
    );
    assert.equal(reloaded.unseen([refusal]).length, 0, "a reload must not re-chime its own past");
    assert.equal(
      reloaded.unseen([event({ ledger: 78, transactionHash: "f".repeat(64) })]).length,
      1,
      "and must still alert on something genuinely new",
    );
  });

  it("writes the record under its scope, so a reload of that scope reads it back", () => {
    const storage = createDedupeStorage();
    saveAlertDedupe(testnet, ["k1", "k2"], storage);
    assert.equal(JSON.parse(storage.raw()!).scope, "testnet|GA,GB");
    assert.deepEqual(loadAlertDedupe(testnet, storage), ["k1", "k2"]);
  });

  it("starts the record over when the network changes", () => {
    const storage = createDedupeStorage();
    saveAlertDedupe(testnet, ["k1"], storage);
    assert.deepEqual(loadAlertDedupe({ ...testnet, network: "pubnet" }, storage), []);
  });

  it("starts the record over when the watched guard set changes", () => {
    const storage = createDedupeStorage();
    saveAlertDedupe(testnet, ["k1"], storage);
    assert.deepEqual(loadAlertDedupe({ ...testnet, guards: ["GB"] }, storage), []);
    assert.deepEqual(loadAlertDedupe({ ...testnet, guards: ["GB", "GA", "GC"] }, storage), []);
  });

  it("counts a re-ordered guard set as the same watch list", () => {
    const storage = createDedupeStorage();
    saveAlertDedupe(testnet, ["k1"], storage);
    assert.deepEqual(loadAlertDedupe({ network: "testnet", guards: ["GA", "GB"] }, storage), [
      "k1",
    ]);
    assert.equal(
      alertDedupeScopeKey(testnet),
      alertDedupeScopeKey({ network: "testnet", guards: ["GA", "GB", "GA"] }),
    );
  });

  it("reads nothing when the stored record is corrupt", () => {
    for (const value of [
      "{not json",
      "null",
      '"k1"',
      '{"scope":"testnet|GA,GB","keys":"k1"}',
      '{"scope":"testnet|GA,GB","keys":[1,null,"ok"]}',
    ]) {
      const storage = createDedupeStorage({ [ALERT_DEDUPE_STORAGE_KEY]: value });
      const loaded = loadAlertDedupe(testnet, storage);
      assert.ok(Array.isArray(loaded), `for ${value}`);
      for (const key of loaded) assert.equal(typeof key, "string");
    }
  });

  it("keeps only the newest identities, so the stored record is bounded too", () => {
    const storage = createDedupeStorage();
    const keys = Array.from({ length: ALERT_DEDUPE_PERSIST_LIMIT + 25 }, (_, index) => `k${index}`);
    saveAlertDedupe(testnet, keys, storage);
    const loaded = loadAlertDedupe(testnet, storage);
    assert.equal(loaded.length, ALERT_DEDUPE_PERSIST_LIMIT);
    assert.equal(loaded[0], `k25`, "the oldest identities are the ones dropped");
    assert.equal(loaded.at(-1), `k${ALERT_DEDUPE_PERSIST_LIMIT + 24}`);
  });

  it("is inert with no storage at all, which is the server-render path", () => {
    assert.deepEqual(loadAlertDedupe(testnet, null), []);
    assert.doesNotThrow(() => saveAlertDedupe(testnet, ["k1"], null));
  });
});

/**
 * #314: what the panel says the channels are actually doing.
 *
 * Three facts get conflated by a single switch: what the operator asked for,
 * what the browser permits, and what the last delivery did. Each is reported
 * separately, and none of them is inferred from the others.
 */
describe("effective channel state (#314)", () => {
  const shown: NotificationDelivery = { delivered: true, reason: "delivered" };
  const refused: NotificationDelivery = { delivered: false, reason: "not-allowed" };

  it("keeps the operator's switch separate from the browser's permission", () => {
    assert.equal(desktopEffective(false, "granted", shown), "off");
    assert.equal(desktopEffective(true, "granted", shown), "delivering");
    assert.equal(desktopEffective(true, "default", null), "awaiting-permission");
    assert.equal(desktopEffective(true, "denied", null), "blocked-by-browser");
    assert.equal(desktopEffective(true, "unsupported", null), "unsupported");
  });

  it("does not claim a delivery this tab has not seen", () => {
    // The reload case: permission was granted in an earlier session, and nothing
    // has had to be shown since this tab opened.
    assert.equal(desktopEffective(true, "granted", null), "ready");
    assert.doesNotMatch(describeDesktopEffective("ready"), /delivering/);
  });

  it("reports a failed delivery as a failing channel", () => {
    assert.equal(desktopEffective(true, "granted", refused), "failing");
    assert.equal(
      desktopEffective(true, "granted", { delivered: false, reason: "failed" }),
      "failing",
    );
  });

  it("ranks permission above an old delivery record", () => {
    assert.equal(desktopEffective(true, "denied", shown), "blocked-by-browser");
    assert.equal(
      desktopEffective(true, "default", { delivered: false, reason: "failed" }),
      "awaiting-permission",
    );
    assert.equal(desktopEffective(false, "denied", refused), "off");
  });

  it("gives every desktop state its own sentence, and the blocked one names the fix", () => {
    const states: DesktopEffective[] = [
      "off",
      "unsupported",
      "blocked-by-browser",
      "awaiting-permission",
      "ready",
      "failing",
      "delivering",
    ];
    const texts = states.map(describeDesktopEffective);
    assert.equal(new Set(texts).size, texts.length);
    for (const text of texts) assert.ok(text.length > 0);
    assert.match(describeDesktopEffective("blocked-by-browser"), /site settings/);
  });

  it("reads the chime's state from the last play report, not from the switch", () => {
    assert.equal(audioEffective(false, null), "off");
    assert.equal(audioEffective(true, null), "needs-unlock");
    assert.equal(
      audioEffective(true, { played: false, reason: "not-unlocked", beeps: 0, durationMs: 190 }),
      "needs-unlock",
    );
    assert.equal(
      audioEffective(true, { played: false, reason: "unsupported", beeps: 0, durationMs: 190 }),
      "unsupported",
    );
    assert.equal(
      audioEffective(true, { played: true, reason: "played", beeps: 2, durationMs: 190 }),
      "ready",
    );
  });

  it("names the chime's silence as something the operator can fix", () => {
    assert.match(describeAudioEffective("needs-unlock"), /click/);
    assert.match(describeAudioEffective("unsupported"), /Web Audio/);
    const texts = ["off", "unsupported", "needs-unlock", "ready"].map((state) =>
      describeAudioEffective(state as AudioEffective),
    );
    assert.equal(new Set(texts).size, texts.length);
  });

  it("distinguishes the three ways a notification goes nowhere", () => {
    const texts = (["delivered", "not-allowed", "unavailable", "failed"] as const).map((reason) =>
      describeNotificationDelivery({ delivered: reason === "delivered", reason }),
    );
    for (const text of texts) assert.ok(text.length > 0);
    assert.equal(new Set(texts).size, texts.length, "each refusal needs its own fix");
    assert.match(
      describeNotificationDelivery({ delivered: false, reason: "not-allowed" }),
      /permission/i,
    );
    assert.match(
      describeNotificationDelivery({ delivered: false, reason: "unavailable" }),
      /browser/,
    );
  });
});

describe("alert settings persistence", () => {
  function createMockStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      raw: () => map.get(ALERT_SETTINGS_STORAGE_KEY) ?? null,
    };
  }

  it("defaults to both channels off when nothing was stored", () => {
    assert.deepEqual(loadAlertSettings(createMockStorage()), DEFAULT_ALERT_SETTINGS);
  });

  it("round-trips what the operator chose", () => {
    const storage = createMockStorage();
    saveAlertSettings({ audio: true, desktop: false, volume: 0.8 }, storage);
    assert.deepEqual(loadAlertSettings(storage), { audio: true, desktop: false, volume: 0.8 });
    assert.equal(JSON.parse(storage.raw()!).audio, true);
  });

  it("clamps a stored volume out of range instead of trusting it", () => {
    const storage = createMockStorage();
    saveAlertSettings({ audio: true, desktop: true, volume: 5 }, storage);
    assert.equal(loadAlertSettings(storage).volume, 1);
  });

  it("treats corrupt or hostile storage as no preference, never as enabled alerts", () => {
    for (const value of ["{not json", "null", '"yes"', '{"audio":"true","volume":"loud"}']) {
      const storage = createMockStorage({ [ALERT_SETTINGS_STORAGE_KEY]: value });
      assert.deepEqual(loadAlertSettings(storage), DEFAULT_ALERT_SETTINGS, `for ${value}`);
    }
  });

  it("is inert with no storage at all, which is the server-render path", () => {
    assert.deepEqual(loadAlertSettings(null), DEFAULT_ALERT_SETTINGS);
    assert.doesNotThrow(() => saveAlertSettings({ audio: true, desktop: true, volume: 0.2 }, null));
  });
});
