(() => {
  // src/runner-media.ts
  var noMediaAdapter = {
    async join(meeting2) {
      await meeting2.join();
    }
  };

  // src/runner.ts
  var base = window.location.pathname.replace(/\/$/, "");
  var meeting;
  var leaving = false;
  var waitingForAdmission = false;
  function setStatus(message) {
    const status = document.querySelector("#meeting-status");
    if (status) status.textContent = message;
  }
  async function request(path, init = {}) {
    const response = await fetch(`${base}/${path}`, { credentials: "same-origin", ...init });
    if (!response.ok) throw new Error(`Runner request failed (${response.status})`);
    return response.json();
  }
  async function event(type, code) {
    await request("events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...code ? { code } : {} })
    });
  }
  function classify(error) {
    const message = String(error?.message ?? error ?? "").toLowerCase();
    if (message.includes("captcha")) return "captcha_required";
    if (message.includes("password required")) return "meeting_password_required";
    if (message.includes("password")) return "meeting_password_rejected";
    return "meeting_join_failed";
  }
  async function start() {
    if (window.meetingJoinStarted) return;
    window.meetingJoinStarted = true;
    const joinButton = document.querySelector("#join-meeting");
    if (joinButton) joinButton.disabled = true;
    setStatus("Connecting to Webex\u2026");
    try {
      const boot = await request("bootstrap");
      await event("joining");
      setStatus("Authenticating the configured Webex user\u2026");
      const webex = window.Webex?.init({
        appName: "openclaw-webex-auto-join",
        appPlatform: "openclaw",
        credentials: { access_token: boot.accessToken }
      });
      if (!webex) throw new Error("Webex Meetings SDK is unavailable");
      await new Promise((resolve, reject) => {
        webex.once("ready", resolve);
        webex.once("error", reject);
      });
      await webex.meetings.register();
      meeting = await webex.meetings.create(boot.destination ?? boot.meetingId ?? boot.joinLink);
      meeting.on?.("meeting:self:left", () => {
        if (!leaving) event("ended").catch(() => void 0);
      });
      meeting.on?.("meeting:self:guestAdmitted", () => {
        waitingForAdmission = false;
        setStatus("Joined the Webex meeting.");
        event("joined").catch(() => void 0);
      });
      meeting.on?.("meeting:self:lobbyWaiting", () => {
        waitingForAdmission = true;
        setStatus("Waiting for the host to admit this Webex user.");
        event("waiting_for_admission").catch(() => void 0);
      });
      meeting.on?.("error", (error) => event("error", classify(error)).catch(() => void 0));
      if (meeting.passwordStatus === "REQUIRED") {
        if (!boot.password) throw new Error("meeting password required");
        setStatus("Verifying the meeting password\u2026");
        const result = await meeting.verifyPassword(boot.password);
        if (result?.requiredCaptcha) throw new Error("captcha required");
        if (!result?.isPasswordValid) throw new Error("meeting password rejected");
      }
      setStatus("Joining the Webex meeting without media\u2026");
      await noMediaAdapter.join(meeting);
      webex.meetings.on?.("meeting:removed", (removed) => {
        if (!leaving && (!removed?.id || removed.id === meeting?.id)) event("ended").catch(() => void 0);
      });
      if (!waitingForAdmission) {
        setStatus("Joined the Webex meeting.");
        await event("joined");
      }
      setInterval(() => event("heartbeat").catch(() => void 0), 15e3);
      setInterval(checkControl, 1e3);
    } catch (error) {
      const code = classify(error);
      setStatus(`Could not join the Webex meeting (${code}).`);
      await event("error", code).catch(() => void 0);
    }
  }
  async function checkControl() {
    if (leaving) return;
    try {
      const control = await request("control");
      if (!control.leave) return;
      leaving = true;
      await meeting?.leave?.();
      await event("left");
    } catch {
    }
  }
  document.querySelector("#join-meeting")?.addEventListener("click", () => start());
  if (document.body?.dataset?.autostart === "true") queueMicrotask(() => start());
})();
