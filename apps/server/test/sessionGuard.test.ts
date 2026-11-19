import { describe, expect, it } from "vitest";
import { type AttachedSessionSource, SessionGuard, sessionHasEnded } from "../src/session/sessionGuard";

const S = "S-20261119-GARD";
const OTHER = "S-20261119-OTHR";
const CODE = "WK-AAAA-BBBB-C";

type Phase =
  | "lobby"
  | "onboarding"
  | "round_active"
  | "round_complete"
  | "game_complete"
  | "closed"
  | "aborted";
type Attached = { sessionId: string; phase: Phase; codes?: string[] } | null;
type Busy = "none" | "attribution" | "exporting" | "both";

/** A guard over a stub hub (attached session, release/reload calls logged) and a stub job runner. */
function setup(attached: Attached, busy: Busy, busySession = S) {
  const calls: string[] = [];
  const hub: { -readonly [K in keyof AttachedSessionSource]: AttachedSessionSource[K] } = {
    session: null,
    release: (id) => calls.push(`release ${id}`),
    reloadActiveSession: () => calls.push("reload"),
  };
  let hasJob = false;
  const guard = new SessionGuard({
    hub,
    jobs: {
      activeJob: (id) => (hasJob && id === busySession ? { jobId: "J-1", status: "running" } : undefined),
    },
  });
  // an export that stays in progress (the guard keeps exports itself), started before the
  // session was attached (resumed) again, since a running session cannot start one
  if (busy === "exporting" || busy === "both")
    void guard.exportAudio(busySession, () => new Promise(() => {}));
  // "both" in this order only: an export refuses to start while a job is queued
  hasJob = busy === "attribution" || busy === "both";
  hub.session = attached && {
    sessionId: attached.sessionId,
    state: {
      phase: attached.phase,
      seats: Object.fromEntries((attached.codes ?? []).map((c, i) => [i + 1, { participantCode: c }])),
    },
  };
  return { guard, calls };
}

const RUNNING_PHASES: Phase[] = ["lobby", "onboarding", "round_active", "round_complete"];
const ENDED_PHASES: Phase[] = ["game_complete", "closed", "aborted"];

const JOB = "An attribution of this session is queued or running";
const EXPORT = "An audio export of this session is being written";

/** operation × busy → the refusal while the session is NOT running (null = allowed). */
const BUSY_TABLE: Array<[op: string, busy: Busy, reason: string | null, message: string | null]> = [
  ["delete-session", "none", null, null],
  ["delete-session", "attribution", "attribution", `${JOB}: delete the session when it is done.`],
  ["delete-session", "exporting", "exporting", `${EXPORT}: delete the session when it is done.`],
  ["delete-session", "both", "attribution", `${JOB}: delete the session when it is done.`],
  ["delete-audio", "none", null, null],
  ["delete-audio", "attribution", "attribution", `${JOB}: wait until it ends.`],
  ["delete-audio", "exporting", "exporting", `${EXPORT}: delete the audio when it is done.`],
  ["delete-audio", "both", "attribution", `${JOB}: wait until it ends.`],
  ["start-attribution", "none", null, null],
  [
    "start-attribution",
    "attribution",
    "attribution",
    "An attribution of this session is already running (J-1).",
  ],
  ["start-attribution", "exporting", "exporting", `${EXPORT}: start the attribution when it is done.`],
  ["start-attribution", "both", "exporting", `${EXPORT}: start the attribution when it is done.`],
  ["export-audio", "none", null, null],
  ["export-audio", "attribution", "attribution", `${JOB}: export when it ends.`],
  ["export-audio", "exporting", null, null], // several exports may be written at once
  ["export-audio", "both", "attribution", `${JOB}: export when it ends.`],
  ["erase-participant", "none", null, null],
  ["erase-participant", "attribution", "attribution", `${JOB} (session ${S}): erase when it is done.`],
  ["erase-participant", "exporting", "exporting", `${EXPORT} (session ${S}): erase when it is done.`],
  ["erase-participant", "both", "attribution", `${JOB} (session ${S}): erase when it is done.`],
];

/** The message for a running session (erasure: when the code is in it). */
const RUNNING: Record<string, string> = {
  "delete-session": "This session is still running. Close or abort it first, then delete it.",
  "delete-audio": "This session is still running. Close or abort it first, then delete its audio.",
  "start-attribution":
    "This session is still running. Speaker attribution works after the session: end, close or abort it first.",
  "export-audio":
    "This session is still running. Exporting audio works after the session: end, close or abort it first.",
  "erase-participant":
    "This participant is in the running session. Withdraw them, end the session, then erase.",
};

/** Run one operation through the guard (the operation itself returns "done"). */
async function run(guard: SessionGuard, op: string) {
  switch (op) {
    case "delete-session":
      return guard.deleteSession(S, () => "done");
    case "erase-participant":
      return guard.eraseParticipant(
        CODE,
        () => [S],
        () => "done",
      );
    case "export-audio":
      return guard.exportAudio(S, async () => "done");
    case "delete-audio":
    case "start-attribution":
      return guard.check(op, S);
    default:
      throw new Error(op);
  }
}

describe("SessionGuard: may this operation change the session now?", () => {
  describe.each(ENDED_PHASES.map((p) => [p]))("attached, %s (not running)", (phase) => {
    it.each(BUSY_TABLE)("%s while busy=%s → %s", async (op, busy, reason, message) => {
      const { guard } = setup({ sessionId: S, phase, codes: [CODE] }, busy);
      const v = await run(guard, op);
      if (reason === null) expect(v.ok).toBe(true);
      else expect(v).toEqual({ ok: false, status: 409, reason, sessionId: S, message });
    });
  });

  describe.each(RUNNING_PHASES.map((p) => [p]))("attached, %s (running)", (phase) => {
    it.each(BUSY_TABLE)("%s while busy=%s", async (op, busy) => {
      const { guard } = setup({ sessionId: S, phase, codes: [CODE] }, busy);
      const v = await run(guard, op);
      // every operation checks the running session first, before any job or export
      expect(v).toEqual({ ok: false, status: 409, sessionId: S, reason: "running", message: RUNNING[op] });
    });
  });

  it.each(BUSY_TABLE)("not attached: %s while busy=%s → %s", async (op, busy, reason, message) => {
    for (const attached of [null, { sessionId: OTHER, phase: "round_active" as const }]) {
      const { guard } = setup(attached, busy);
      const v = await run(guard, op);
      if (reason === null) expect(v.ok).toBe(true);
      else expect(v).toEqual({ ok: false, status: 409, reason, sessionId: S, message });
    }
  });

  it("another session's work does not block this one", async () => {
    const { guard } = setup({ sessionId: S, phase: "closed" }, "both", OTHER);
    for (const op of Object.keys(RUNNING)) expect((await run(guard, op)).ok, op).toBe(true);
  });

  it("start-attribution: the caller's precondition runs after the running check, before the busy checks", () => {
    const precondition = () => "This session has no audio.";
    expect(
      setup({ sessionId: S, phase: "round_active" }, "none").guard.check("start-attribution", S, {
        precondition,
      }),
    ).toMatchObject({ reason: "running" });
    for (const busy of ["none", "attribution", "exporting"] as const)
      expect(setup(null, busy).guard.check("start-attribution", S, { precondition })).toEqual({
        ok: false,
        status: 409,
        reason: "precondition",
        sessionId: S,
        message: "This session has no audio.",
      });
    expect(setup(null, "none").guard.check("start-attribution", S, { precondition: () => null }).ok).toBe(
      true,
    );
  });

  describe("around the operation", () => {
    it("deleteSession releases the session from the hub first, and not when refused", () => {
      const { guard, calls } = setup({ sessionId: S, phase: "game_complete" }, "none");
      const v = guard.deleteSession(S, () => {
        calls.push("delete");
        return 7;
      });
      expect(v).toEqual({ ok: true, value: 7 });
      expect(calls).toEqual([`release ${S}`, "delete"]);
      const refused = setup({ sessionId: S, phase: "lobby" }, "none");
      refused.guard.deleteSession(S, () => refused.calls.push("delete"));
      expect(refused.calls).toEqual([]);
    });

    it("eraseParticipant reloads the attached session afterwards only when the code was in it", () => {
      for (const [codes, sessions, expected] of [
        [[CODE], [S], ["erase", "reload"]],
        // seat rebound to someone else: the code is still in the session's stored data
        [["WK-ZZZZ-ZZZZ-Z"], [S], ["erase", "reload"]],
        [["WK-ZZZZ-ZZZZ-Z"], [OTHER], ["erase"]],
      ] as const) {
        const { guard, calls } = setup({ sessionId: S, phase: "closed", codes: [...codes] }, "none");
        const v = guard.eraseParticipant(
          CODE,
          () => sessions,
          () => calls.push("erase"),
        );
        expect(v.ok).toBe(true);
        expect(calls).toEqual(expected);
      }
    });

    it("eraseParticipant: a running session without the code does not block; it reads the sessions after the running check", () => {
      const running = setup({ sessionId: S, phase: "round_active", codes: ["WK-ZZZZ-ZZZZ-Z"] }, "none");
      expect(
        running.guard.eraseParticipant(
          CODE,
          () => [S],
          () => "done",
        ),
      ).toEqual({ ok: true, value: "done" });
      const withCode = setup({ sessionId: S, phase: "round_active", codes: [CODE] }, "none");
      const sessionsOf = () => {
        throw new Error("read before the running check");
      };
      expect(withCode.guard.eraseParticipant(CODE, sessionsOf, () => "done")).toMatchObject({
        reason: "running",
      });
      expect(withCode.calls).toEqual([]);
    });

    it("eraseParticipant checks every session the code occurs in, in order", () => {
      const { guard } = setup(null, "exporting", OTHER);
      expect(
        guard.eraseParticipant(
          CODE,
          () => [S, OTHER],
          () => "done",
        ),
      ).toMatchObject({
        reason: "exporting",
        sessionId: OTHER,
        message: `${EXPORT} (session ${OTHER}): erase when it is done.`,
      });
    });

    it("exportAudio keeps the session busy while the export is written, also when it fails", async () => {
      const { guard } = setup(null, "none");
      let finish!: () => void;
      const pending = guard.exportAudio(S, () => new Promise<string>((r) => (finish = () => r("files"))));
      expect(guard.check("delete-audio", S)).toMatchObject({ reason: "exporting" });
      const second = guard.exportAudio(S, async () => {
        throw new Error("disk full");
      });
      await expect(second).rejects.toThrow("disk full");
      expect(guard.check("delete-audio", S)).toMatchObject({ reason: "exporting" }); // the first still runs
      finish();
      expect(await pending).toEqual({ ok: true, value: "files" });
      expect(guard.check("delete-audio", S).ok).toBe(true);
    });
  });

  it("running: attached and not ended; with no hub nothing runs", () => {
    expect(setup({ sessionId: S, phase: "lobby" }, "none").guard.running(S)).toBe(true);
    expect(setup({ sessionId: S, phase: "game_complete" }, "none").guard.running(S)).toBe(false);
    expect(setup({ sessionId: OTHER, phase: "lobby" }, "none").guard.running(S)).toBe(false);
    expect(new SessionGuard({ hub: null, jobs: { activeJob: () => undefined } }).running(S)).toBe(false);
  });

  it("sessionHasEnded: game_complete, closed and aborted (the CLI reads it from the session row's status)", () => {
    expect(ENDED_PHASES.every(sessionHasEnded)).toBe(true);
    expect(RUNNING_PHASES.some(sessionHasEnded)).toBe(false);
  });
});
