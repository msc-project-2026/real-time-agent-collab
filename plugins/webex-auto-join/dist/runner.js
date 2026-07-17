(() => {
  // src/runner-media.ts
  var noMediaAdapter = {
    async join(meeting2) {
      await meeting2.join();
    }
  };
  var WORKLET_SOURCE = `
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTapProcessor);
`;
  var SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
  var MAX_BUFFERED_BYTES = 1 << 20;
  function floatToPcm16(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      output[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    return output;
  }
  function openSocket(config, sessionId) {
    const url = `ws://127.0.0.1:${config.port}/?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(config.token)}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new Error("audio bridge connection failed")), { once: true });
    });
  }
  function attachSink(stream) {
    const element = document.createElement("audio");
    element.srcObject = stream;
    element.muted = true;
    element.autoplay = true;
    element.setAttribute("aria-hidden", "true");
    document.body.appendChild(element);
    element.play().catch(() => void 0);
    return element;
  }
  async function createTapNode(context, onSamples) {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (event2) => onSamples(event2.data);
      return { node, kind: "worklet" };
    } catch {
      const node = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
      node.onaudioprocess = (event2) => onSamples(new Float32Array(event2.inputBuffer.getChannelData(0)));
      return { node, kind: "script-processor" };
    }
  }
  async function attachTap(meeting2, config, hooks) {
    const stream = await new Promise((resolve, reject) => {
      const existing = meeting2.mediaProperties?.remoteAudioStream?.outputStream;
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error("remote audio stream never arrived")), 3e4);
      meeting2.on("media:ready", (media) => {
        if (media?.type !== "remoteAudio" || !media.stream) return;
        clearTimeout(timer);
        resolve(media.stream);
      });
      meeting2.addMedia({ localStreams: {}, audioEnabled: true, videoEnabled: false, shareAudioEnabled: false, shareVideoEnabled: false }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    attachSink(stream);
    const context = new AudioContext({ sampleRate: config.sampleRate });
    if (context.state === "suspended") await context.resume().catch(() => void 0);
    const socket = await openSocket(config, hooks.sessionId);
    socket.send(JSON.stringify({
      type: "hello",
      sessionId: hooks.sessionId,
      sampleRate: context.sampleRate,
      channels: 1,
      encoding: "linear16"
    }));
    const send = (samples) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      socket.send(floatToPcm16(samples).buffer);
    };
    const source = context.createMediaStreamSource(stream);
    const { node, kind } = await createTapNode(context, send);
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(node);
    node.connect(silence);
    silence.connect(context.destination);
    const stop = () => {
      socket.close(1e3, "meeting_ended");
      context.close().catch(() => void 0);
    };
    meeting2.once?.("meeting:self:left", stop);
    hooks.onNotice("started", `rate=${context.sampleRate} state=${context.state} tap=${kind}`);
  }
  function createAudioTapAdapter(config, hooks) {
    let attached = false;
    const ensureMedia = async (meeting2) => {
      if (attached) return;
      attached = true;
      try {
        await attachTap(meeting2, config, hooks);
      } catch (error) {
        attached = false;
        hooks.onNotice("failed", String(error?.message ?? error));
      }
    };
    return {
      async join(meeting2) {
        await meeting2.join();
        await ensureMedia(meeting2);
      },
      ensureMedia
    };
  }

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
  function errorChain(error, limit = 6) {
    const seen = /* @__PURE__ */ new Set();
    const chain = [];
    let node = error;
    while (node != null && !seen.has(node) && chain.length < limit) {
      seen.add(node);
      chain.push(node);
      node = node?.error ?? node?.cause ?? node?.originalError ?? node?.wrappedError;
    }
    return chain;
  }
  function layerFields(item) {
    const body = item?.body ?? item?.data?.body ?? item?.data ?? {};
    return {
      name: sanitizeDiagnostic(item?.name),
      code: sanitizeDiagnostic(item?.code ?? item?.errorCode ?? item?.statusCode ?? item?.status ?? body?.errorCode ?? body?.code),
      message: sanitizeDiagnostic(item?.message ?? body?.message ?? body?.error ?? (typeof item === "string" ? item : "")),
      sdkMessage: sanitizeDiagnostic(item?.sdkMessage),
      reason: sanitizeDiagnostic(item?.reason ?? body?.reason ?? body?.errorDescription)
    };
  }
  function diagnostic(error, errorStage = stage) {
    const chain = errorChain(error);
    const root = layerFields(chain[0] ?? {});
    if (!root.message) root.message = sanitizeDiagnostic(error);
    const parts = [
      `stage=${sanitizeDiagnostic(errorStage) || "unknown"}`,
      ...root.name ? [`name=${root.name}`] : [],
      ...root.code ? [`sdk_code=${root.code}`] : [],
      ...root.message ? [`message=${root.message}`] : [],
      ...root.sdkMessage && root.sdkMessage !== root.message ? [`sdk_message=${root.sdkMessage}`] : [],
      ...root.reason && root.reason !== root.message ? [`reason=${root.reason}`] : []
    ];
    for (let i = 1; i < chain.length; i++) {
      const layer = layerFields(chain[i]);
      const detail = layer.message || layer.reason || layer.sdkMessage;
      const fields = [
        ...layer.name ? [`cause${i}_name=${layer.name}`] : [],
        ...layer.code ? [`cause${i}_code=${layer.code}`] : [],
        ...detail ? [`cause${i}_message=${detail}`] : []
      ];
      if (fields.length) parts.push(...fields);
    }
    return parts.join("; ");
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
      const media = boot.audioTap ? createAudioTapAdapter(boot.audioTap, {
        sessionId: boot.sessionId,
        onNotice: (code, detail) => {
          event("audio_tap", code, detail).catch(() => void 0);
        }
      }) : noMediaAdapter;
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
        media.ensureMedia?.(meeting).catch(() => void 0);
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
      setStatus(boot.audioTap ? "Joining the Webex meeting\u2026" : "Joining the Webex meeting without media\u2026");
      stage = "meeting_join";
      await media.join(meeting);
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
