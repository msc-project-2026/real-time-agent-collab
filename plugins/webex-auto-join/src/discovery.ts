export type DestinationKind = 'web_link' | 'sip_address' | 'meeting_number' | 'meeting_id';

export type DiscoveredInvitation = {
  destination: string;
  destinationKind: DestinationKind;
  joinLink?: string;
  password?: string;
  meetingId?: string;
  meetingNumber?: string;
  discoveredAt: string;
};

function value(input: unknown) {
  const normalized = String(input ?? '').trim();
  return normalized && !normalized.startsWith('${') ? normalized : '';
}

/**
 * Pick the string handed to `webex.meetings.create()`, most-reliable first.
 *
 * The SDK infers the join type from this string. A REST meeting id
 * (e.g. `<series>_I_<instance>`) matches no known type, so the SDK falls back to
 * PSTN dial parsing and libphonenumber rejects it as TOO_LONG. The web link is an
 * unambiguous URL and preferred; SIP address is the fallback, then meeting number,
 * and only as a last resort the id (which is kept separately for identity/dedup).
 */
export function selectDestination(meeting: any): { destination: string; kind: DestinationKind } | null {
  const webLink = value(meeting?.webLink);
  if (webLink) return { destination: webLink, kind: 'web_link' };
  const sipAddress = value(meeting?.sipAddress);
  if (sipAddress) return { destination: sipAddress, kind: 'sip_address' };
  const meetingNumber = value(meeting?.meetingNumber);
  if (meetingNumber) return { destination: meetingNumber, kind: 'meeting_number' };
  const meetingId = value(meeting?.id);
  if (meetingId) return { destination: meetingId, kind: 'meeting_id' };
  return null;
}

/** Convert a Webex Meetings API object into the runner's stable destination. */
export function createDiscoveredInvitation(meeting: any, roomId: string): DiscoveredInvitation | null {
  const meetingId = value(meeting?.id);
  const webLink = value(meeting?.webLink);
  const selected = selectDestination(meeting);
  if (!roomId || !selected) return null;
  return {
    destination: selected.destination,
    destinationKind: selected.kind,
    ...(webLink ? { joinLink: webLink } : {}),
    ...(value(meeting?.password) ? { password: value(meeting.password) } : {}),
    ...(meetingId ? { meetingId } : {}),
    ...(value(meeting?.meetingNumber) ? { meetingNumber: value(meeting.meetingNumber) } : {}),
    discoveredAt: new Date().toISOString(),
  };
}

export function isJoinableMeeting(meeting: any) {
  return value(meeting?.meetingType) === 'meeting' && ['lobby', 'inProgress'].includes(value(meeting?.state));
}

export function isTerminalMeeting(meeting: any) {
  return value(meeting?.meetingType) === 'meeting' && value(meeting?.state) === 'ended';
}
