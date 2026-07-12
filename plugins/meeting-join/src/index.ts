import { MeetingJoinService } from './service';

const SERVICE_KEY = Symbol.for('openclaw.meeting-join.service');

function toToolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

function getSharedService(api: any) {
  const root = globalThis as any;
  if (!root[SERVICE_KEY]) {
    const pluginConfig = api.pluginConfig
      ?? api.config?.plugins?.entries?.['meeting-join']?.config
      ?? api.config
      ?? {};
    root[SERVICE_KEY] = new MeetingJoinService(api.runtime, pluginConfig, api.logger ?? console);
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
    description: 'Leave the active Webex meeting for the specified originating Webex space.',
    parameters: {
      type: 'object',
      properties: { room_id: { type: 'string', description: 'The current Webex room ID from the inbound context.' } },
      required: ['room_id'],
    },
    execute: async (_id: string, args: any) => toToolResult(await resolveService().leave(String(args?.room_id ?? ''))),
  }, { optional: true });
}

function register(api: any) {
  const mode = api.registrationMode ?? 'full';
  if (mode !== 'full' && mode !== 'tool-discovery') return;

  // Tool discovery must remain side-effect free. Resolve lazily so the full
  // runtime registration owns initialization, while both loads still share
  // the exact same process-wide session/nonces service.
  let service: MeetingJoinService | undefined = mode === 'full' ? getSharedService(api) : undefined;
  const resolveService = () => service ??= getSharedService(api);
  registerTools(api, resolveService);

  if (mode !== 'full') return;

  api.registerHttpRoute({
    path: '/meeting-join/runner/',
    auth: 'plugin',
    match: 'prefix',
    handler: (req: any, res: any) => resolveService().handleRunnerRoute(req, res),
  });

  api.on?.('gateway_start', async () => resolveService().start());
  api.on?.('gateway_stop', async () => resolveService().stop());

  // Older local plugin runtimes do not dispatch gateway lifecycle hooks. Start
  // asynchronously as a compatibility fallback; the service stays fail-closed.
  queueMicrotask(() => resolveService().start().catch(() => undefined));
}

export default register;
export { getSharedService, register };
