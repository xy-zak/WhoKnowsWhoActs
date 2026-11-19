/**
 * The seat monitor of one session: the volatile per-seat figures the facilitator's dashboard shows
 * live, and nothing else reads. Telemetry counts, focus, visibility, idle, round trip and clock
 * offset, the region a player hovers, the browser's latest mic meter reading merged with what the
 * server stored of that seat's audio, and the last LIVE_TELEMETRY_KEPT live telemetry items (for a
 * facilitator page that opens later).
 *
 * Nothing here is stored or sent to a player. Owned by the SessionManager, which feeds it what its
 * submit* methods accepted and every event it appends live (`observe`), so a seat's figures are
 * cleared where the event that ends them is logged. A new session starts with a new monitor.
 */
import {
  AUDIO_SILENCE_DB,
  type AudioLevel,
  LIVE_TELEMETRY_TYPES,
  type ReadonlyGameState,
  type SeatLiveStats,
  type SeatMicStats,
  type StoredEvent,
  type StoredTelemetry,
  seatList,
  type TelemetryItem,
} from "@wkwa/shared";
import type { z } from "zod";
import type { SeatAudioStats } from "../audio/live";

/** Latest `audio:level` of a seat (volatile: never stored). */
export type MicLevelReading = z.output<typeof AudioLevel>;

/** How many live telemetry items are kept for a facilitator page that opens later. */
const LIVE_TELEMETRY_KEPT = 500;

export interface SeatMonitorDeps {
  state: () => ReadonlyGameState;
  /** What the server stored of a seat's audio (tracks, recorded time, last chunk). */
  trackStats: (seat: number) => SeatAudioStats;
}

function emptyStats(seat: number): SeatLiveStats {
  return {
    seat,
    focused: null,
    visible: null,
    idle: false,
    rttMs: null,
    offsetMs: null,
    hoverRegionId: null,
    screen: null,
    telemetryCount: 0,
    lastTelemetryTs: null,
  };
}

export class SeatMonitor {
  private readonly stats = new Map<number, SeatLiveStats>();
  private readonly micLevels = new Map<number, MicLevelReading>();
  private live: StoredTelemetry[] = [];

  constructor(private readonly deps: SeatMonitorDeps) {}

  private seat(seat: number): SeatLiveStats {
    let st = this.stats.get(seat);
    if (!st) {
      st = emptyStats(seat);
      this.stats.set(seat, st);
    }
    return st;
  }

  /**
   * A telemetry batch of a seat was stored: count it, take the figures some items carry, and keep
   * the live items. Returns the live items (for the facilitator pages open now).
   */
  telemetry(
    seat: number,
    items: readonly TelemetryItem[],
    stored: readonly StoredTelemetry[],
    now: number,
  ): StoredTelemetry[] {
    const st = this.seat(seat);
    st.telemetryCount += stored.length;
    st.lastTelemetryTs = now;
    for (const it of items) {
      if (it.type === "focus_change") st.focused = it.payload.focused;
      else if (it.type === "visibility_change") st.visible = it.payload.visible;
      else if (it.type === "idle") st.idle = it.payload.state === "start";
      else if (it.type === "clock_sync") {
        st.rttMs = it.payload.rttMs;
        st.offsetMs = it.payload.offsetMs;
      } else if (it.type === "screen_view") st.screen = it.payload.screen;
    }
    const live = stored.filter((t) => LIVE_TELEMETRY_TYPES.has(t.type));
    if (live.length) {
      this.live.push(...live);
      if (this.live.length > LIVE_TELEMETRY_KEPT) this.live.splice(0, this.live.length - LIVE_TELEMETRY_KEPT);
    }
    return live;
  }

  /** The region a seat's player points at now (null = none). */
  hover(seat: number, regionId: string | null) {
    this.seat(seat).hoverRegionId = regionId;
  }

  /** A seat's latest mic meter reading (the SessionManager checks first that the seat is recorded). */
  micLevel(seat: number, level: MicLevelReading) {
    this.micLevels.set(seat, level);
  }

  /** The seat's browser disconnected: its meter goes blank and it hovers nothing. */
  disconnected(seat: number) {
    this.micLevels.delete(seat);
    const st = this.stats.get(seat);
    if (st) st.hoverRegionId = null;
  }

  /** Clear the figures an event appended live ends. */
  observe(ev: StoredEvent) {
    switch (ev.type) {
      case "SeatUnbound":
        // the next client in this seat starts with empty figures
        this.stats.delete(ev.payload.seat);
        this.micLevels.delete(ev.payload.seat);
        break;
      // the mic meter of a seat that is no longer recorded goes blank
      case "ParticipantWithdrawn":
      case "MicCheckSkipped":
        this.micLevels.delete(ev.payload.seat);
        break;
      // nobody is recorded once the session has ended
      case "SessionClosed":
      case "SessionAborted":
        this.micLevels.clear();
        break;
      default:
        break;
    }
  }

  /** The figures of every seat for the dashboard; with the mic column when the session records audio. */
  dashboardStats(): Record<number, SeatLiveStats> {
    const state = this.deps.state();
    const out: Record<number, SeatLiveStats> = {};
    for (const { seat } of seatList(state)) {
      const st = this.stats.get(seat) ?? emptyStats(seat);
      out[seat] = state.audio.enabled ? { ...st, mic: this.micStats(seat) } : st;
    }
    return out;
  }

  /** The last live telemetry items, oldest first. */
  get liveTelemetry(): readonly StoredTelemetry[] {
    return this.live;
  }

  /** LIVE mic figures of a seat: the browser's latest meter reading plus what the server stored. */
  private micStats(seat: number): SeatMicStats {
    const level = this.micLevels.get(seat);
    const stored = this.deps.trackStats(seat);
    return {
      state: level?.state ?? "idle",
      rmsDb: level?.rmsDb ?? AUDIO_SILENCE_DB,
      peakDb: level?.peakDb ?? AUDIO_SILENCE_DB,
      lastChunkServerTs: stored.lastChunkServerTs,
      pendingChunks: level?.pendingChunks ?? 0,
      tracks: stored.tracks,
      recordedMs: Math.round(stored.recordedMs),
    };
  }
}
