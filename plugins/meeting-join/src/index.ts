import bridge from './bridge.cjs';
import { MeetingJoinService } from './service';

function toToolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

function register(api: any) {
  const pluginConfig = api.config?.plugins?.entries?.['meeting-join']?.config ?? api.config ?? {};
  const service = new MeetingJoinService(api.runtime, pluginConfig, api.logger ?? console);
  bridge.setMeetingJoinService(service);

  api.registerTool({
    name: 'join_webex_meeting',
    description: 'Join the Webex meeting represented by a sanitized meeting candidate. The candidate contains no credentials.',
    parameters: {
      type: 'object',
      properties: { candidate_id: { type: 'string', description: 'Opaque meeting candidate ID from the inbound Webex context.' } },
      required: ['candidate_id'],
    },
    execute: async (_id: string, args: any) => toToolResult(await service.join(String(args?.candidate_id ?? ''))),
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
