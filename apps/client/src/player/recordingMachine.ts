import { type AudioStartReason, type AudioStopReason, type PlayerView, STOP_REASON_FOR } from "@wkwa/shared";

/*
 * The recording controller's decisions (player/recording.ts) as a small state machine: `step`
 * takes the state, one input and the latest PlayerView, and returns the next state and what to
 * ask of the capture engine. It is pure (no engine, socket, storage or timers), and it is the one
 * place where the reason of every track start and stop the controller asks for is decided. The
 * engine adds its own (context_resumed, track_ended, …: audio/MicRecorder.ts).
 *
 *   idle{next}  ── settle: the verdict says record (and the mic check's Start was clicked) ─▶ running   start(next ?? mic_check | reload)
 *   idle{next}  ── click: the verdict says record ─────────────────────────────────────────▶ running   start(next ?? mic_check | reload)
 *   running     ── settle: the verdict says no ───────────────────────▶ idle{resume | reconnect | null}  stop(the verdict's reason; disconnect while detached)
 *   running     ── resync: the first view after a reconnect / re-attach ─▶ idle{reconnect | resume | null}  resend, stop(disconnect; the verdict's reason if it says no)
 *   running     ── mic_failed: the engine reports denied / error ─────▶ failed{permission_regained | null}
 *   failed{next} ── click, or device_change while the verdict says record ─▶ idle{next ?? permission_regained | null}
 *   unbound: forgets the click and the tracks; a running track then stops with client_stop and what is pending is cleared
 *
 * The next start reason travels on the phase (`next`), set by the transition that stopped or lost
 * the track: `resume` after a pause, `reconnect` after a disconnect, `permission_regained` after a
 * lost microphone (once a track ran in this page). Without one, the default: `mic_check` at the
 * mic check (unless this tab recorded the seat before: a reload), `reload` past it.
 */

export type Phase =
  /** Not capturing. `next`: why the next track starts (null: the default reason). */
  | { readonly at: "idle"; readonly next: AudioStartReason | null }
  /** Capture was asked for (the engine's start()) and not stopped since. */
  | { readonly at: "running" }
  /** The microphone was lost (denied / error): waits for a click or a device / permission change. */
  | { readonly at: "failed"; readonly next: AudioStartReason | null };

export interface Machine {
  readonly phase: Phase;
  /** The participant clicked Start in the mic check (this page; forgotten when the seat is unbound). */
  readonly gesture: boolean;
  /** A track started in this page. */
  readonly tracked: boolean;
  /** Since the last view: the socket reconnected, or the session was detached (the seat kept). */
  readonly link: "steady" | "reconnected" | "detached";
  /** The seat was unbound: drop what is pending once nothing records. */
  readonly clear: boolean;
}

/** What the controller asks of the engine, in order (it awaits each stop). */
export type Effect =
  | { readonly do: "start"; readonly reason: AudioStartReason }
  | { readonly do: "stop"; readonly reason: AudioStopReason }
  /** resend what was not acknowledged, now (the engine's onReconnect) */
  | { readonly do: "resend" }
  /** drop everything pending (the engine's clearPending) */
  | { readonly do: "clear" };

export type Input =
  /** the mic check's Start / "Try again" (a click) */
  | "click"
  /** a microphone was plugged in or the permission changed */
  | "device_change"
  /** the engine reported denied or error */
  | "mic_failed"
  /** the engine began a track */
  | "track_started"
  /** the engine's start() threw (it is disposed) */
  | "start_failed"
  /** the socket connected again (not the first time) */
  | "reconnected"
  /** the session was detached on the server; the seat is kept */
  | "detached"
  /** the seat was unbound */
  | "unbound"
  /** a sync pass begins: settle a reconnect or a re-attach with the first view after it */
  | "resync"
  /** start or stop to match the server's verdict */
  | "settle";

export interface Context {
  /** The latest PlayerView (null: no seat, or the session is detached). */
  view: PlayerView | null;
  /** This tab recorded a track for the seat before (sessionStorage: survives a reload). */
  trackedInTab: boolean;
}

export interface Step {
  m: Machine;
  effects: Effect[];
}

export const INITIAL: Machine = {
  phase: { at: "idle", next: null },
  gesture: false,
  tracked: false,
  link: "steady",
  clear: false,
};

/** The server wants this browser to capture now. */
export function wantsRecording(v: PlayerView | null): boolean {
  return !!v && v.audio.enabled && v.audio.record;
}

/** The mic check is this seat's current step. */
export function atMicCheck(v: PlayerView | null): boolean {
  return !!v && v.phase === "onboarding" && !v.me.withdrawn && v.me.nextStep === "mic_check";
}

/** Why the running track stops when the server no longer wants recording (its verdict's reason). */
export function stopReasonFor(v: PlayerView | null): AudioStopReason {
  const why = v?.audio.notRecording;
  return why ? STOP_REASON_FOR[why] : "client_stop";
}

/** Why the track after a stop with `reason` starts, unless something else happens first. */
function nextAfter(reason: AudioStopReason): AudioStartReason | null {
  return reason === "paused" ? "resume" : reason === "disconnect" ? "reconnect" : null;
}

const none = (m: Machine): Step => ({ m, effects: [] });

function start(m: Machine, ctx: Context): Step {
  const next = m.phase.at === "running" ? null : m.phase.next;
  const reason = next ?? (atMicCheck(ctx.view) && !ctx.trackedInTab ? "mic_check" : "reload");
  return { m: { ...m, phase: { at: "running" } }, effects: [{ do: "start", reason }] };
}

function stop(m: Machine, reason: AudioStopReason): Step {
  return { m: { ...m, phase: { at: "idle", next: nextAfter(reason) } }, effects: [{ do: "stop", reason }] };
}

/** Leaves `failed`: the next track starts with its reason, or permission_regained once a track ran. */
function recover(m: Machine): Machine {
  if (m.phase.at !== "failed") return m;
  const next = m.phase.next ?? (m.tracked ? "permission_regained" : null);
  return { ...m, phase: { at: "idle", next } };
}

/** At the mic check, nothing records before its Start click. */
const awaitingClick = (m: Machine, v: PlayerView | null) => atMicCheck(v) && !m.gesture;

export function step(m: Machine, input: Input, ctx: Context): Step {
  const v = ctx.view;
  const want = wantsRecording(v);
  switch (input) {
    case "click": {
      // inside the click: the engine is started at once (browsers start audio only from a gesture)
      const clicked = recover({ ...m, gesture: true });
      return clicked.phase.at === "idle" && want ? start(clicked, ctx) : none(clicked);
    }
    case "device_change":
      // a microphone came back (plugged in, or the permission was granted again): try once more
      return m.phase.at === "failed" && want && !awaitingClick(m, v) ? none(recover(m)) : none(m);
    case "mic_failed":
      if (m.phase.at !== "running") return none(m);
      return none({ ...m, phase: { at: "failed", next: m.tracked ? "permission_regained" : null } });
    case "track_started":
      return none(m.tracked ? m : { ...m, tracked: true });
    case "start_failed":
      return none(m.phase.at === "running" ? { ...m, phase: { at: "idle", next: null } } : m);
    case "reconnected":
      return none(m.link === "detached" ? m : { ...m, link: "reconnected" });
    case "detached":
      return none({ ...m, link: "detached" });
    case "unbound":
      return none({
        phase: m.phase.at === "running" ? m.phase : { at: "idle", next: null },
        gesture: false,
        tracked: false,
        link: "steady",
        clear: true,
      });
    case "resync": {
      // the first view after a reconnect / re-attach: resend what was not acknowledged (oldest
      // first), then close the old track; the next settle opens a new one
      if (!v || m.link === "steady") return none(m);
      const steady: Machine = { ...m, link: "steady" };
      if (m.phase.at !== "running") return { m: steady, effects: [{ do: "resend" }] };
      const s = stop(steady, want ? "disconnect" : stopReasonFor(v));
      return { m: s.m, effects: [{ do: "resend" }, ...s.effects] };
    }
    case "settle": {
      let s = none(m);
      if (want && m.phase.at === "idle" && !awaitingClick(m, v)) s = start(m, ctx);
      else if (!want && m.phase.at === "running")
        s = stop(m, m.link === "detached" ? "disconnect" : stopReasonFor(v));
      if (!v && s.m.phase.at !== "running" && s.m.clear)
        s = { m: { ...s.m, clear: false }, effects: [...s.effects, { do: "clear" }] };
      return s;
    }
  }
}
