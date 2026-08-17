// ********* ROUTING/TOOL.JS *********
'use strict';

const ALLOWED_ROUTES = new Set([
  'recall_request',
  'task_request',
  'config_request',
]);

// Pending validated route results keyed by spaceId.
// Written by tool execute(); consumed (and cleared) by takePendingRouteResult().
const pendingRouteResults = new Map();

function takePendingRouteResult(spaceId) {
  const result = pendingRouteResults.get(spaceId) ?? null;
  pendingRouteResults.delete(spaceId);
  return result;
}

// Exposed for testing: seed a result without going through the tool.
function setPendingRouteResult(spaceId, result) {
  pendingRouteResults.set(spaceId, result);
}

function routeMessageTool() {
  return {
    name: 'route_message',
    description:
      'Classify and route an inbound Webex message. Call this tool once successfully. If it returns { ok: false }, correct the parameters and retry (up to 3 attempts total). Do not answer the user or call any other tool.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description:
            'The spaceId from the message metadata in the prompt. Copy it verbatim.',
        },
        routes: {
          type: 'array',
          description:
            'Routes that apply to this message. Use an empty array when none apply.',
          items: {
            type: 'object',
            properties: {
              route: {
                type: 'string',
                enum: ['recall_request', 'task_request', 'config_request'],
              },
              reason: {
                type: 'string',
                description: 'A brief reason why this route applies.',
              },
            },
            required: ['route', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['spaceId', 'routes'],
      additionalProperties: false,
    },
    async execute(_toolUseId, params) {
      const { spaceId, routes } = params ?? {};

      if (!spaceId || typeof spaceId !== 'string') {
        return { ok: false, error: '`spaceId` must be a non-empty string.' };
      }
      if (!Array.isArray(routes)) {
        return { ok: false, error: '`routes` must be an array.' };
      }

      const errors = [];
      const seenRoutes = new Set();

      for (let i = 0; i < routes.length; i++) {
        const entry = routes[i];
        const routeVal = entry?.route;
        const reason = entry?.reason;

        if (!ALLOWED_ROUTES.has(routeVal)) {
          errors.push(
            `routes[${i}].route "${routeVal}" is not a valid route value. ` +
              `Allowed: ${[...ALLOWED_ROUTES].join(', ')}.`
          );
        } else if (seenRoutes.has(routeVal)) {
          errors.push(`routes[${i}].route "${routeVal}" is duplicated.`);
        } else {
          seenRoutes.add(routeVal);
        }

        if (!reason || typeof reason !== 'string' || !reason.trim()) {
          errors.push(`routes[${i}].reason must be a non-empty string.`);
        }
      }

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      if (pendingRouteResults.has(spaceId)) {
        console.warn(
          '[webex:route_message] overwriting pending result (tool called more than once)',
          {
            spaceId,
          }
        );
      }

      pendingRouteResults.set(spaceId, { routes });
      return { ok: true, routeCount: routes.length };
    },
  };
}

module.exports = {
  routeMessageTool,
  takePendingRouteResult,
  setPendingRouteResult,
};
