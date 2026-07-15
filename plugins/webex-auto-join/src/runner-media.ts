export interface RunnerMediaAdapter {
  join(meeting: any): Promise<void>;
}

/**
 * v1 intentionally joins without adding local or remote media. A future audio
 * receiver/transcription implementation plugs into this boundary without
 * changing webhook discovery or session coordination.
 */
export const noMediaAdapter: RunnerMediaAdapter = {
  async join(meeting: any) {
    await meeting.join();
  },
};
