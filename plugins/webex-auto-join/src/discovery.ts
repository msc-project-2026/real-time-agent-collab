export type DiscoveredInvitation = {
  destination: string;
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

/** Convert a Webex Meetings API object into the runner's stable destination. */
export function createDiscoveredInvitation(meeting: any, roomId: string): DiscoveredInvitation | null {
  const meetingId = value(meeting?.id);
  const sipAddress = value(meeting?.sipAddress);
  const webLink = value(meeting?.webLink);
  const destination = meetingId || sipAddress || webLink;
  if (!roomId || !destination) return null;
  return {
    destination,
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
