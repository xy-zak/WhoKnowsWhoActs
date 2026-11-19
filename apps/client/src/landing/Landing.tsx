import type { LandingStatus } from "@wkwa/shared";
import { useEffect, useState } from "react";
import { Centered } from "../player/chrome";
import { DisplayMenu } from "../player/DisplayMenu";
import { Button, Callout, Icon, playerPrefs, StatusTag, TooltipLayer, useDisplayPrefs } from "../ui";

/** How often the page asks whether a session is open (ms). */
const POLL_MS = 2000;

/** The welcome page's status, asked again every POLL_MS; null until the first answer, "offline" when unreachable. */
function useLandingStatus(): LandingStatus | null | "offline" {
  const [status, setStatus] = useState<LandingStatus | null | "offline">(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await fetch("/api/landing", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as LandingStatus;
        if (!stop) setStatus(s);
      } catch {
        if (!stop) setStatus("offline");
      }
      if (!stop) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);
  return status;
}

/**
 * The welcome page (served over plain HTTP on LANDING_PORT, and at /landing): the first page a
 * participant opens. Title and welcome; once the researcher has opened a session, a "Join live
 * session" button to the game page (HTTPS), which then gives this computer a client number and the
 * researcher a seat to bind it to. Before the button, a line on the browser warning the next page
 * shows (self-signed certificate) and why it is there.
 */
export function Landing() {
  useDisplayPrefs(playerPrefs);
  const status = useLandingStatus();
  const live = status !== null && status !== "offline" && status.live;
  return (
    <>
      <Centered title="Welcome" icon="info" width={720}>
        <h1 style={{ margin: 0 }}>Who Knows, Who Acts?</h1>
        <p style={{ margin: 0 }}>
          Welcome, and thank you for coming. On this computer you will play a short map game together with the
          other participants in the room. Before the game starts you will read the information about the study
          and decide whether you want to take part.
        </p>
        {status === null ? (
          <p className="muted cursor">Connecting to the game server</p>
        ) : status === "offline" ? (
          <StatusTag tone="warn" icon="disconnected">
            cannot reach the game server: please tell the researcher
          </StatusTag>
        ) : live ? (
          <>
            {status.certificate === "self-signed" && <CertificateNote status={status} />}
            <Button
              variant="primary"
              size="lg"
              icon="next"
              onClick={() => window.location.assign(status.joinUrl)}
              tip="Open the game page; the researcher then gives this computer its seat"
            >
              Join live session
            </Button>
          </>
        ) : (
          <p className="muted cursor">
            The session has not started yet. Keep this page open: a button to join appears here as soon as the
            researcher starts it
          </p>
        )}
      </Centered>
      <DisplayMenu />
      <TooltipLayer />
    </>
  );
}

/** The browser warning on the game page: what to click, and why it is there. */
function CertificateNote({ status }: { status: LandingStatus }) {
  return (
    <Callout icon="info">
      <div className="col" style={{ gap: "var(--s1)", textAlign: "left" }}>
        <span>
          <strong>Your browser will show a security warning on the next page</strong> (such as "Your
          connection is not private"). Click <strong>Advanced</strong>, then <strong>Proceed to …</strong> (or{" "}
          <strong>Accept the risk and continue</strong>). You only need to do this once.
        </span>
        <span className="muted small">
          <Icon name="lock" /> Why: the game runs only on this room's network, without the internet, so its
          security certificate is made by the researcher's laptop instead of a public authority. Your browser
          cannot check such a certificate and warns about it. The connection is still encrypted, which your
          browser requires before it lets the game use the microphone.
        </span>
        {status.fingerprintSha256 && (
          <details className="small muted">
            <summary>Certificate fingerprint (SHA-256), to compare with the one the browser shows</summary>
            <span className="mono" style={{ overflowWrap: "anywhere" }}>
              {status.fingerprintSha256}
            </span>
          </details>
        )}
      </div>
    </Callout>
  );
}
