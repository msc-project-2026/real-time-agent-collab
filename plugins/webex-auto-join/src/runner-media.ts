export interface RunnerMediaAdapter {
  join(meeting: any): Promise<void>;
  // Re-attempts the tap once the runner leaves the lobby. addMedia is rejected while
  // the guest is still waiting, so admission is the second chance to wire audio up.
  ensureMedia?(meeting: any): Promise<void>;
}

export interface AudioTapConfig {
  port: number;
  token: string;
  sampleRate: number;
}

export interface AudioTapHooks {
  sessionId: string;
  // Non-fatal: tap problems must never fail an otherwise healthy meeting join.
  onNotice(code: string, detail?: string): void;
}

/**
 * Joins without adding local or remote media. Retained as the fallback for when the
 * gateway hands the runner no audio bridge, so meeting join keeps working with the
 * tap switched off.
 */
export const noMediaAdapter: RunnerMediaAdapter = {
  async join(meeting: any) {
    await meeting.join();
  },
};

// Copies each render quantum off the audio thread. The input buffer is recycled by the
// engine, so it has to be copied before it crosses the port.
const WORKLET_SOURCE = `
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

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
// Loopback should never back up; if it does, drop rather than grow the heap unbounded.
const MAX_BUFFERED_BYTES = 1 << 20;

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

function openSocket(config: AudioTapConfig, sessionId: string) {
  const url = `ws://127.0.0.1:${config.port}/?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(config.token)}`;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  return new Promise<WebSocket>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('audio bridge connection failed')), { once: true });
  });
}

// Chrome will not pull a remote WebRTC track into a Web Audio graph unless the stream
// is also attached to a media element. The element stays muted so the headless tab
// renders nothing; the tap reads the stream independently of playback.
function attachSink(stream: MediaStream) {
  const element = document.createElement('audio');
  element.srcObject = stream;
  element.muted = true;
  element.autoplay = true;
  element.setAttribute('aria-hidden', 'true');
  document.body.appendChild(element);
  element.play().catch(() => undefined);
  return element;
}

async function createTapNode(context: AudioContext, onSamples: (samples: Float32Array) => void) {
  try {
    // A blob keeps the worklet self-contained; the runner is a single bundled IIFE and
    // has no second asset URL to serve a module from.
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try { await context.audioWorklet.addModule(url); }
    finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(context, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (event) => onSamples(event.data as Float32Array);
    return { node: node as AudioNode, kind: 'worklet' };
  } catch {
    const node = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
    node.onaudioprocess = (event) => onSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
    return { node: node as AudioNode, kind: 'script-processor' };
  }
}

async function attachTap(meeting: any, config: AudioTapConfig, hooks: AudioTapHooks) {
  const stream: MediaStream = await new Promise((resolve, reject) => {
    const existing = meeting.mediaProperties?.remoteAudioStream?.outputStream;
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error('remote audio stream never arrived')), 30_000);
    meeting.on('media:ready', (media: any) => {
      if (media?.type !== 'remoteAudio' || !media.stream) return;
      clearTimeout(timer);
      resolve(media.stream);
    });
    // Receive-only: no local streams means no microphone, and every send-side flag is
    // off. The SDK defaults each of these to true when omitted.
    meeting
      .addMedia({ localStreams: {}, audioEnabled: true, videoEnabled: false, shareAudioEnabled: false, shareVideoEnabled: false })
      .catch((error: unknown) => { clearTimeout(timer); reject(error); });
  });

  attachSink(stream);

  const context = new AudioContext({ sampleRate: config.sampleRate });
  // Without a user gesture the context can start suspended, which silently yields no
  // audio rather than an error.
  if (context.state === 'suspended') await context.resume().catch(() => undefined);

  const socket = await openSocket(config, hooks.sessionId);
  socket.send(JSON.stringify({
    type: 'hello',
    sessionId: hooks.sessionId,
    sampleRate: context.sampleRate,
    channels: 1,
    encoding: 'linear16',
  }));

  const send = (samples: Float32Array) => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(floatToPcm16(samples).buffer);
  };

  const source = context.createMediaStreamSource(stream);
  const { node, kind } = await createTapNode(context, send);
  // Both node types are only pulled when the graph reaches a destination, so route
  // through a silent gain rather than leaving the tap dangling.
  const silence = context.createGain();
  silence.gain.value = 0;
  source.connect(node);
  node.connect(silence);
  silence.connect(context.destination);

  const stop = () => { socket.close(1000, 'meeting_ended'); context.close().catch(() => undefined); };
  meeting.once?.('meeting:self:left', stop);

  hooks.onNotice('started', `rate=${context.sampleRate} state=${context.state} tap=${kind}`);
}

export function createAudioTapAdapter(config: AudioTapConfig, hooks: AudioTapHooks): RunnerMediaAdapter {
  let attached = false;

  const ensureMedia = async (meeting: any) => {
    if (attached) return;
    attached = true;
    try {
      await attachTap(meeting, config, hooks);
    } catch (error) {
      attached = false;
      hooks.onNotice('failed', String((error as any)?.message ?? error));
    }
  };

  return {
    async join(meeting: any) {
      await meeting.join();
      await ensureMedia(meeting);
    },
    ensureMedia,
  };
}
