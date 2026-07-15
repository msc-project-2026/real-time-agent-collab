import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBEX_API = 'https://webexapis.com/v1';
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class WebexApiError extends Error {
  status: number;
  body: string;

  constructor(method: string, pathname: string, status: number, body: string) {
    super(`Webex ${method} ${pathname} failed (${status})`);
    this.name = 'WebexApiError';
    this.status = status;
    this.body = body;
  }
}

export async function webexRequest(
  token: string,
  pathname: string,
  init: { method?: string; body?: unknown } = {}
) {
  const method = init.method ?? 'GET';
  const response = await fetch(pathname.startsWith('https://') ? pathname : `${WEBEX_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) throw new WebexApiError(method, pathname, response.status, text);
  let data: any = {};
  if (text) data = JSON.parse(text);
  return { data, headers: response.headers };
}

export async function webexList(token: string, pathname: string) {
  const items: any[] = [];
  let next: string | undefined = pathname;
  while (next) {
    const result = await webexRequest(token, next);
    items.push(...(Array.isArray(result.data?.items) ? result.data.items : []));
    const link = result.headers?.get?.('link') ?? '';
    const match = String(link).match(/<([^>]+)>;\s*rel="next"/i);
    next = match?.[1];
    if (next && !next.startsWith(`${WEBEX_API}/`)) throw new Error('Webex pagination returned an unexpected origin');
  }
  return items;
}

export type OwnedWebhookSpec = {
  name: string;
  resource: string;
  event: string;
};

export async function ensureOwnedWebhooks(
  token: string,
  targetUrl: string,
  secret: string,
  specs: OwnedWebhookSpec[]
) {
  const existing = await webexList(token, '/webhooks?max=1000');
  for (const spec of specs) {
    const matches = existing.filter((item) => item?.name === spec.name);
    const keeper = matches.find((item) =>
      item?.targetUrl === targetUrl && item?.resource === spec.resource && item?.event === spec.event && item?.status !== 'disabled'
    );
    for (const item of matches) {
      if (item === keeper) continue;
      await webexRequest(token, `/webhooks/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    }
    if (!keeper) {
      await webexRequest(token, '/webhooks', {
        method: 'POST',
        body: { ...spec, targetUrl, ...(secret ? { secret } : {}) },
      });
    }
  }
}

export function verifyWebhookSignature(secret: string, rawBody: Buffer, signature: unknown) {
  if (!secret || typeof signature !== 'string' || !/^[a-f\d]{40}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha1', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(signature.toLowerCase());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function readRawBody(req: any, maxBytes = MAX_WEBHOOK_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error: any = new Error('webhook_body_too_large');
      error.code = 'webhook_body_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
