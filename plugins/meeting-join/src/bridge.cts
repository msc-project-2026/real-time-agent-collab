'use strict';

// This CommonJS bridge is shared with the existing CommonJS Webex channel.
// The ESM plugin entry installs the live service at gateway startup.
let service: any = null;

function fallbackRedact(text: unknown) {
  let value = String(text ?? '')
    .replace(/^(Meeting password:\s*).*$/gim, '$1[REDACTED]')
    .replace(/^(Meeting password for video system\s*\n?\s*).*$/gim, '$1[REDACTED]');
  const invitationStart = value.search(/^(Meeting link:|https:\/\/[^\s]+\.webex\.com\/)/im);
  if (invitationStart >= 0) value = `${value.slice(0, invitationStart).trimEnd()}\n[Webex meeting invitation redacted]`;
  return value;
}

function setMeetingJoinService(value: any) {
  service = value;
}

async function prepareMeetingInbound(input: any) {
  if (!service) {
    return {
      text: fallbackRedact(input?.text),
      candidateId: null,
      credentialsAvailable: false,
      redacted: true,
    };
  }
  return service.prepareInbound(input);
}

module.exports = { setMeetingJoinService, prepareMeetingInbound };
