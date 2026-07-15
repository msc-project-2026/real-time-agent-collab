import { WEBEX_API } from './webex';

/** Webex-space message delivery kept independent from meeting coordination. */
export class WebexMessageDelivery {
  constructor(private readonly botToken: string) {}

  async send(roomId: string, markdown: string) {
    const response = await fetch(`${WEBEX_API}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, markdown }),
    });
    if (!response.ok) throw new Error(`Webex status send failed (${response.status})`);
  }
}
