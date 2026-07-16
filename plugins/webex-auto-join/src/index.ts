import { MeetingJoinService } from './service';
import { fileURLToPath } from 'node:url';
import manifest from '../openclaw.plugin.json' with { type: 'json' };

const SERVICE_KEY = Symbol.for('openclaw.webex-auto-join.service');

function assetPaths() {
  return {
    runner: fileURLToPath(new URL('./runner.js', import.meta.url)),
    sdk: fileURLToPath(new URL('./webex.min.js', import.meta.url)),
  };
}

function validationEntry() {
  const entry: any = {};
  Object.defineProperty(entry, Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata'), {
    value: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      activation: manifest.activation,
      configSchema: manifest.configSchema,
      tools: manifest.contracts.tools.map((name) => ({ name, optional: true })),
    },
  });
  return entry;
}

function toToolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

function getSharedService(api: any) {
  const root = globalThis as any;
  if (!root[SERVICE_KEY]) {
    const pluginConfig = api.pluginConfig
      ?? api.config?.plugins?.entries?.['webex-auto-join']?.config
      ?? api.config
      ?? {};
    root[SERVICE_KEY] = new MeetingJoinService(api.runtime, pluginConfig, api.logger ?? console, assetPaths());
  }
  return root[SERVICE_KEY] as MeetingJoinService;
}

function registerTools(api: any, resolveService: () => MeetingJoinService) {

  api.registerTool({
    name: 'join_webex_meeting',
    description: 'Join a Webex meeting using the meeting credentials supplied in the Webex request.',
    parameters: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'Current Webex RoomId.' },
        parent_id: { type: 'string', description: 'Current MessageThreadId when present.' },
        meeting_link: { type: 'string', description: 'HTTPS Webex meeting link from the invitation.' },
        meeting_password: { type: 'string', description: 'Ordinary Meeting password from the invitation; do not use the video-system password.' },
      },
      required: ['room_id', 'meeting_link', 'meeting_password'],
    },
    execute: async (_id: string, args: any) => toToolResult(await resolveService().join(args)),
  }, { optional: true });

  api.registerTool({
    name: 'leave_webex_meeting',
    description: 'Leave an active Webex meeting. Pass the current room ID; if that space has no active session, the sole active meeting is left instead, so call this whenever any meeting is active — no meeting link is needed. If several meetings are active it returns ambiguous_active_meeting with the candidates.',
    parameters: {
      type: 'object',
      properties: { room_id: { type: 'string', description: 'The current Webex room ID from the inbound context.' } },
      required: ['room_id'],
    },
    execute: async (_id: string, args: any) => toToolResult(await resolveService().leave(String(args?.room_id ?? ''))),
  }, { optional: true });

  api.registerTool({
    name: 'inspect_webex_meeting_runner',
    description: 'Inspect the secure meeting runner for one accepted join session and return a semantic snapshot with fresh action refs.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID returned by join_webex_meeting.' },
      },
      required: ['session_id'],
    },
    execute: async (_id: string, args: any) => toToolResult(
      await resolveService().inspectRunner(String(args?.session_id ?? ''))
    ),
  }, { optional: true });

  api.registerTool({
    name: 'act_webex_meeting_runner',
    description: 'Click one fresh semantic ref in the secure meeting runner. The plugin resolves the session tab internally; do not supply a targetId.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID returned by join_webex_meeting.' },
        ref: { type: 'string', description: 'Fresh clickable ref selected from inspect_webex_meeting_runner output.' },
      },
      required: ['session_id', 'ref'],
    },
    execute: async (_id: string, args: any) => toToolResult(
      await resolveService().actOnRunner(String(args?.session_id ?? ''), String(args?.ref ?? ''))
    ),
  }, { optional: true });

  api.registerTool({
    name: 'webex_auto_join_status',
    description: 'Report Webex auto-join coverage, upcoming meetings, pending joins, active sessions, and sanitized failure codes.',
    parameters: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'Optional Webex room ID used to restrict the report to one space.' },
      },
    },
    execute: async (_id: string, args: any) => toToolResult(
      resolveService().status(String(args?.room_id ?? '').trim() || undefined)
    ),
  }, { optional: true });
}

function register(api?: any) {
  // The authoring CLI invokes a default function without arguments to inspect
  // defineToolPlugin-compatible metadata. Runtime loaders pass the plugin API.
  if (!api) return validationEntry();
  const mode = api.registrationMode ?? 'full';
  if (!['full', 'discovery', 'tool-discovery'].includes(mode)) return;

  // Tool discovery must remain side-effect free. Resolve lazily so the full
  // runtime registration owns initialization, while both loads still share
  // the exact same process-wide session/nonces service.
  let service: MeetingJoinService | undefined = mode === 'full' ? getSharedService(api) : undefined;
  const resolveService = () => service ??= getSharedService(api);
  registerTools(api, resolveService);

  if (mode === 'tool-discovery') return;

  api.registerHttpRoute({
    path: '/webhooks/webex-auto-join',
    auth: 'plugin',
    match: 'exact',
    handler: (req: any, res: any) => resolveService().handleWebhookRoute(req, res),
  });

  api.registerHttpRoute({
    path: '/webex-auto-join/runner/',
    auth: 'plugin',
    match: 'prefix',
    handler: (req: any, res: any) => resolveService().handleRunnerRoute(req, res),
  });

  if (mode === 'full') {
    api.registerService({
      id: 'webex-auto-join',
      start: async () => resolveService().start(),
      stop: async () => resolveService().stop(),
    });
  }
}

export default register;
export { getSharedService, register };
