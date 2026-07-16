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
  var stage = "runner_start";
  function setStatus(message) {
    const status = document.querySelector("#meeting-status");
    if (status) status.textContent = message;
  }
  async function request(path, init = {}) {
    const response = await fetch(`${base}/${path}`, { credentials: "same-origin", ...init });
    if (!response.ok) throw new Error(`Runner request failed (${response.status})`);
    return response.json();
  }
  async function event(type, code, detail) {
    await request("events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...code ? { code } : {}, ...detail ? { detail } : {} })
    });
  }
  function classify(error) {
    const message = String(error?.message ?? error ?? "").toLowerCase();
    if (message.includes("captcha")) return "captcha_required";
    if (message.includes("password required")) return "meeting_password_required";
    if (message.includes("password")) return "meeting_password_rejected";
    return "meeting_join_failed";
  }
  function sanitizeDiagnostic(value) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/\b(access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi, "$1=[redacted]").replace(/(^|[^A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?=$|[^A-Za-z0-9_+/=-])/g, "$1[redacted-value]").replace(/\s+/g, " ").trim().slice(0, 500);
  }
  function diagnostic(error, errorStage = stage) {
    const item = error ?? {};
    const body = item?.body ?? item?.data?.body ?? item?.data ?? {};
    const name = sanitizeDiagnostic(item?.name);
    const sdkCode = sanitizeDiagnostic(item?.code ?? item?.errorCode ?? item?.statusCode ?? item?.status ?? body?.errorCode ?? body?.code);
    const message = sanitizeDiagnostic(item?.message ?? body?.message ?? body?.error ?? error);
    return [
      `stage=${sanitizeDiagnostic(errorStage) || "unknown"}`,
      ...name ? [`name=${name}`] : [],
      ...sdkCode ? [`sdk_code=${sdkCode}`] : [],
      ...message ? [`message=${message}`] : []
    ].join("; ");
  }
  async function start() {
    if (window.meetingJoinStarted) return;
    window.meetingJoinStarted = true;
    const joinButton = document.querySelector("#join-meeting");
    if (joinButton) joinButton.disabled = true;
    setStatus("Connecting to Webex\u2026");
    try {
      stage = "bootstrap";
      const boot = await request("bootstrap");
      await event("joining");
      setStatus("Authenticating the configured Webex user\u2026");
      stage = "sdk_initialization";
      const webex = window.Webex?.init({
        appName: "openclaw-webex-auto-join",
        appPlatform: "openclaw",
        credentials: { access_token: boot.accessToken }
      });
      if (!webex) throw new Error("Webex Meetings SDK is unavailable");
      stage = "sdk_ready";
      await new Promise((resolve, reject) => {
        webex.once("ready", resolve);
        webex.once("error", reject);
      });
      stage = "device_registration";
      await webex.meetings.register();
      stage = "meeting_lookup";
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
      meeting.on?.("error", (error) => event("error", classify(error), diagnostic(error, "meeting_event")).catch(() => void 0));
      if (meeting.passwordStatus === "REQUIRED") {
        if (!boot.password) throw new Error("meeting password required");
        setStatus("Verifying the meeting password\u2026");
        stage = "password_verification";
        const result = await meeting.verifyPassword(boot.password);
        if (result?.requiredCaptcha) throw new Error("captcha required");
        if (!result?.isPasswordValid) throw new Error("meeting password rejected");
      }
      setStatus("Joining the Webex meeting without media\u2026");
      stage = "meeting_join";
      await noMediaAdapter.join(meeting);
      webex.meetings.on?.("meeting:removed", (removed) => {
        if (!leaving && (!removed?.id || removed.id === meeting?.id)) event("ended").catch(() => void 0);
      });
      if (!waitingForAdmission) {
        stage = "joined";
        setStatus("Joined the Webex meeting.");
        await event("joined");
      }
      setInterval(() => event("heartbeat").catch(() => void 0), 15e3);
      setInterval(checkControl, 1e3);
    } catch (error) {
      const code = classify(error);
      setStatus(`Could not join the Webex meeting (${code}).`);
      await event("error", code, diagnostic(error)).catch(() => void 0);
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
