import { MeetingJoinService } from './service';

function toToolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

function register(api: any) {
  const pluginConfig = api.config?.plugins?.entries?.['meeting-join']?.config ?? api.config ?? {};
  const service = new MeetingJoinService(api.runtime, pluginConfig, api.logger ?? console);

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
    execute: async (_id: string, args: any) => toToolResult(await service.join(args)),
  }, { optional: true });

  api.registerTool({
    name: 'leave_webex_meeting',
    description: 'Leave the active Webex meeting for the specified originating Webex space.',
    parameters: {
      type: 'object',
      properties: { room_id: { type: 'string', description: 'The current Webex room ID from the inbound context.' } },
      required: ['room_id'],
    },
    execute: async (_id: string, args: any) => toToolResult(await service.leave(String(args?.room_id ?? ''))),
  }, { optional: true });

  api.registerHttpRoute({
    path: '/meeting-join/runner/',
    auth: 'plugin',
    match: 'prefix',
    handler: (req: any, res: any) => service.handleRunnerRoute(req, res),
  });

  api.on?.('gateway_start', async () => service.start());
  api.on?.('gateway_stop', async () => service.stop());

  // Older local plugin runtimes do not dispatch gateway lifecycle hooks. Start
  // asynchronously as a compatibility fallback; the service stays fail-closed.
  queueMicrotask(() => service.start().catch(() => undefined));
}

export default register;
export { register };
