import { randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

// The runner tap and Deepgram Flux both speak linear16 mono. Chrome resamples the
// remote WebRTC track to whatever the AudioContext requests, so the tap asks for
// this rate directly rather than resampling in JS.
export const AUDIO_SAMPLE_RATE = 16_000;

const INT16_FULL_SCALE = 32_768;
const REPORT_INTERVAL_MS = 2_000;

type Tap = {
  sessionId: string;
  token: string;
  socket?: any;
  sampleRate?: number;
  totalSamples: number;
  // Reset every report window.
  sumSquares: number;
  windowSamples: number;
  peak: number;
  reportedAt: number;
  transcription?: DeepgramStream;
};

export type TranscriptTurn = { sessionId: string; text: string; startedAt?: number; duration?: number };
export type DeepgramConfig = { apiKey: string; baseUrl: string; onTurn: (turn: TranscriptTurn) => Promise<void> | void };

// Each meeting gets its own live connection, so separate rooms can never have
// their PCM or completed turns mixed together.
class DeepgramStream {
  private socket: WebSocket;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private finalParts: string[] = [];
  private closed = false;

  constructor(private readonly tap: Tap, private readonly cfg: DeepgramConfig, private readonly log: any) {
    const url = new URL(cfg.baseUrl);
    if (!url.searchParams.has('model')) url.searchParams.set('model', 'flux-general-en');
    if (!url.searchParams.has('encoding')) url.searchParams.set('encoding', 'linear16');
    if (!url.searchParams.has('sample_rate')) url.searchParams.set('sample_rate', String(tap.sampleRate ?? AUDIO_SAMPLE_RATE));
    if (!url.searchParams.has('channels')) url.searchParams.set('channels', '1');
    if (!url.searchParams.has('interim_results')) url.searchParams.set('interim_results', 'true');
    this.socket = new WebSocket(url, { headers: { Authorization: `Token ${cfg.apiKey}` } });
    this.socket.on('open', () => this.flush());
    this.socket.on('message', (data) => this.consume(String(data)));
    this.socket.on('error', (error) => this.log?.warn?.(`[webex-auto-join] Deepgram socket error session=${tap.sessionId}: ${error.message}`));
    this.socket.on('close', () => { this.closed = true; });
  }

  write(buffer: Buffer) {
    if (this.closed) return;
    if (this.socket.readyState === WebSocket.OPEN) return this.socket.send(buffer);
    // The tap can start before the TLS websocket opens. Retain only one second.
    if (this.pendingBytes + buffer.length <= AUDIO_SAMPLE_RATE * 2) { this.pending.push(buffer); this.pendingBytes += buffer.length; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    this.socket.close();
  }

  private flush() {
    for (const buffer of this.pending) this.socket.send(buffer);
    this.pending = [];
    this.pendingBytes = 0;
    this.log?.info?.(`[webex-auto-join] Deepgram stream open session=${this.tap.sessionId}`);
  }

  private consume(raw: string) {
    let result: any;
    try { result = JSON.parse(raw); } catch { return; }
    if (result?.type !== 'Results') return;
    const text = String(result?.channel?.alternatives?.[0]?.transcript ?? '').trim();
    if (result?.is_final && text) this.finalParts.push(text);
    // Deepgram's endpoint marker ensures the agent is invoked only per turn.
    if (!result?.speech_final) return;
    const turn = this.finalParts.join(' ').trim();
    this.finalParts = [];
    if (!turn) return;
    Promise.resolve(this.cfg.onTurn({ sessionId: this.tap.sessionId, text: turn, startedAt: Number(result?.start) || undefined, duration: Number(result?.duration) || undefined }))
      .catch((error) => this.log?.warn?.(`[webex-auto-join] transcript delivery failed session=${this.tap.sessionId}: ${error?.message ?? error}`));
  }
}

function dbfs(amplitude: number) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

function formatDb(amplitude: number) {
  const value = dbfs(amplitude);
  return value === -Infinity ? '-inf' : value.toFixed(1);
}

function tokensMatch(expected: string, received: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(address: unknown) {
  const value = String(address ?? '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

/**
 * Loopback WebSocket sink for meeting audio.
 *
 * The Webex SDK only exposes remote audio as a MediaStream inside the browser, but
 * transcription and the proactivity gate both run here in Node. The gateway's
 * registerHttpRoute only hands plugins (req, res) with no upgrade hook, so this owns
 * its own ephemeral loopback listener instead of riding the runner's HTTP route.
 *
 * Phase 1 only measures the signal. Deepgram forwarding replaces onPcm later.
 */
export class AudioBridge {
  private wss: any = null;
  private taps = new Map<string, Tap>();
  private port = 0;
  private readonly reportIntervalMs: number;
  private readonly deepgram?: DeepgramConfig;

  constructor(private readonly log: any = console, options: { reportIntervalMs?: number; deepgram?: DeepgramConfig } = {}) {
    this.reportIntervalMs = options.reportIntervalMs ?? REPORT_INTERVAL_MS;
    this.deepgram = options.deepgram;
  }

  async start() {
    if (this.wss) return this.port;
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1 << 20 });
    await new Promise<void>((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
    this.port = this.wss.address().port;
    this.wss.on('connection', (socket: any, req: any) => this.accept(socket, req));
    this.log?.info?.(`[webex-auto-join] audio bridge listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  // Returns the credentials the runner needs, or undefined when the bridge is off.
  // Each runner load mints a fresh token; a relaunch supersedes the previous tap.
  register(sessionId: string) {
    if (!this.wss) return undefined;
    this.taps.get(sessionId)?.socket?.close?.(1000, 'superseded');
    const token = randomBytes(24).toString('base64url');
    this.taps.set(sessionId, {
      sessionId,
      token,
      totalSamples: 0,
      sumSquares: 0,
      windowSamples: 0,
      peak: 0,
      reportedAt: Date.now(),
    });
    return { port: this.port, token, sampleRate: AUDIO_SAMPLE_RATE };
  }

  unregister(sessionId: string) {
    const tap = this.taps.get(sessionId);
    if (!tap) return;
    if (tap.totalSamples > 0) {
      const seconds = (tap.totalSamples / (tap.sampleRate ?? AUDIO_SAMPLE_RATE)).toFixed(1);
      this.log?.info?.(`[webex-auto-join] audio tap closed session=${sessionId} captured=${seconds}s`);
    }
    tap.socket?.close?.(1000, 'session_closed');
    tap.transcription?.close();
    this.taps.delete(sessionId);
  }

  async stop() {
    for (const sessionId of [...this.taps.keys()]) this.unregister(sessionId);
    if (!this.wss) return;
    const server = this.wss;
    this.wss = null;
    this.port = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: any, req: any) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return socket.close(1008, 'loopback_only');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sessionId = url.searchParams.get('session') ?? '';
    const token = url.searchParams.get('token') ?? '';
    const tap = this.taps.get(sessionId);
    if (!tap || !token || !tokensMatch(tap.token, token)) return socket.close(1008, 'unauthorized');
    // A relaunched runner replaces the previous tap rather than doubling the stream.
    tap.socket?.close?.(1000, 'superseded');
    tap.socket = socket;
    socket.on('message', (data: any, isBinary: boolean) => this.consume(tap, data, isBinary));
    socket.on('close', () => { if (tap.socket === socket) tap.socket = undefined; });
    socket.on('error', (error: any) => this.log?.warn?.(`[webex-auto-join] audio tap socket error session=${sessionId}: ${error?.message ?? error}`));
  }

  private consume(tap: Tap, data: any, isBinary: boolean) {
    if (!isBinary) return this.handshake(tap, data);
    const buffer: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    tap.transcription?.write(buffer);
    // A trailing odd byte would desync every following sample.
    const samples = Math.floor(buffer.length / 2);
    for (let i = 0; i < samples; i++) {
      const amplitude = Math.abs(buffer.readInt16LE(i * 2)) / INT16_FULL_SCALE;
      tap.sumSquares += amplitude * amplitude;
      if (amplitude > tap.peak) tap.peak = amplitude;
    }
    tap.totalSamples += samples;
    tap.windowSamples += samples;
    this.report(tap);
  }

  private handshake(tap: Tap, data: any) {
    let hello: any;
    try { hello = JSON.parse(String(data)); } catch { return; }
    if (hello?.type !== 'hello') return;
    tap.sampleRate = Number(hello.sampleRate) || undefined;
    const rateNote = tap.sampleRate === AUDIO_SAMPLE_RATE ? '' : ` (expected ${AUDIO_SAMPLE_RATE})`;
    this.log?.info?.(
      `[webex-auto-join] audio tap open session=${tap.sessionId} rate=${tap.sampleRate}${rateNote} encoding=${hello.encoding} channels=${hello.channels}`
    );
    if (this.deepgram && hello.encoding === 'linear16' && Number(hello.channels) === 1) {
      tap.transcription?.close();
      try { tap.transcription = new DeepgramStream(tap, this.deepgram, this.log); }
      catch (error) { this.log?.warn?.(`[webex-auto-join] Deepgram stream setup failed session=${tap.sessionId}: ${(error as any)?.message ?? error}`); }
    }
  }

  private report(tap: Tap) {
    const now = Date.now();
    if (now - tap.reportedAt < this.reportIntervalMs || tap.windowSamples === 0) return;
    const rms = Math.sqrt(tap.sumSquares / tap.windowSamples);
    const seconds = (tap.totalSamples / (tap.sampleRate ?? AUDIO_SAMPLE_RATE)).toFixed(1);
    // rms at -inf means the tap is wired up but Chrome is handing us digital silence,
    // which is the failure this spike exists to catch.
    this.log?.info?.(
      `[webex-auto-join] audio tap session=${tap.sessionId} captured=${seconds}s rms=${formatDb(rms)}dBFS peak=${formatDb(tap.peak)}dBFS`
    );
    tap.sumSquares = 0;
    tap.windowSamples = 0;
    tap.peak = 0;
    tap.reportedAt = now;
  }
}
