// Runs inside the headless page loaded by meeting-runtime.js — bundle this
// with webpack/esbuild alongside the `webex` npm package into
// meeting-client.html. This file needs real browser WebRTC APIs; it will not
// run under plain Node.

import Webex from 'webex';

let webex = null;
let currentMeeting = null;

window.__startMeetingClient = async function (accessToken, destination) {
  webex = Webex.init({ config: { credentials: { access_token: accessToken } } });

  await webex.meetings.register();
  await webex.meetings.syncMeetings();

  currentMeeting = await webex.meetings.create(destination);

  currentMeeting.on('meeting:receiveTranscription:started', (payload) => {
    // payload shape per Webex JS SDK docs:
    // { personId, transcription: { text }, timestamp, type: 'interim' | 'final' }
    window.__onTranscriptSegment({
      personId: payload.personId,
      text: payload.transcription?.text ?? '',
      isFinal: payload.type === 'final',
      timestamp: payload.timestamp ?? Date.now(),
    });
  });

  currentMeeting.on('meeting:left', () => window.__onMeetingLeft?.());

  await currentMeeting.join({ receiveTranscription: true });
};

window.__leaveMeetingClient = async function () {
  await currentMeeting?.leave();
};
