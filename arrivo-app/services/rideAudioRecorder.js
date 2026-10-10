// In-trip audio recording ("listening device") for the rider and driver apps.
// Identical in both apps; keep them in sync.
//
// How it works: record 30 second pieces, hand each to a small upload queue that
// sends it straight to private storage with a short-lived link from our API,
// then delete the local file. Short pieces mean a crash or a lost signal keeps
// everything already sent.
//
// Nothing here runs unless the server's /api/recordings/config says enabled.
// Consent for a self-started recording is asked by the screen (askConsent) and
// remembered on this device; the Emergency Button skips it. The server also
// refuses a start that does not state consent.
//
// NOT covered by automated tests: the expo-audio calls need a real device.
// The upload queue is (services/audioUploadQueue.test.js).

import { AudioModule, RecordingPresets, setAudioModeAsync } from "expo-audio";
import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as api from "./api";
import { createUploadQueue } from "./audioUploadQueue";

const CHUNK_MS = 30 * 1000;
const CONSENT_KEY = "arrivo_audio_consent_v1";
const CONTENT_TYPE = "audio/mp4";
// Speech does not need music quality: mono, 32 kbps is about 120 KB per piece.
const RECORDING_OPTIONS = { ...RecordingPresets.LOW_QUALITY, numberOfChannels: 1, sampleRate: 22050, bitRate: 32000 };

let session = null; // { token, rideId, recordingId, stopRequested, wake, loop, queue }
const listeners = new Set();
let configCache = null;

function notify() {
  const recording = !!session;
  listeners.forEach((fn) => { try { fn(recording); } catch { /* a bad listener must not break recording */ } });
}

export function onRecordingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const isRecording = () => !!session;
export const isRecordingRide = (rideId) => !!session && session.rideId === rideId;

export async function getRecordingEnabled(token) {
  try {
    if (!configCache || configCache.token !== token) {
      const cfg = await api.getRecordingConfig(token);
      configCache = { token, enabled: !!cfg.enabled, retentionDays: cfg.retentionDays };
    }
    return configCache;
  } catch {
    return { enabled: false };
  }
}

export async function hasStoredConsent() {
  try { return (await SecureStore.getItemAsync(CONSENT_KEY)) === "yes"; } catch { return false; }
}
async function storeConsent() {
  try { await SecureStore.setItemAsync(CONSENT_KEY, "yes"); } catch { /* ask again next time */ }
}

async function uploadOne(s, item) {
  const blob = await (await fetch(item.uri)).blob();
  if (!blob.size) return; // an empty piece is not worth sending
  const { uploadUrl, alreadyUploaded } = await api.requestAudioChunk(s.token, s.recordingId, item.seq, CONTENT_TYPE, blob.size);
  if (!alreadyUploaded) {
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": CONTENT_TYPE }, body: blob });
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
  }
  await api.completeAudioChunk(s.token, s.recordingId, item.seq, item.durationSec);
}

function deleteLocal(uri) {
  try { new File(uri).delete(); } catch { /* already gone */ }
}

async function recordLoop(s) {
  let seq = 0;
  while (!s.stopRequested) {
    let recorder;
    const startedAt = Date.now();
    try {
      recorder = new AudioModule.AudioRecorder(RECORDING_OPTIONS);
      await recorder.prepareToRecordAsync();
      recorder.record();
      // Wait one piece, or until stop is requested.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, CHUNK_MS);
        s.wake = () => { clearTimeout(t); resolve(); };
      });
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) s.queue.enqueue({ seq, uri, durationSec: (Date.now() - startedAt) / 1000 });
      seq++;
    } catch (err) {
      console.warn("Audio recording stopped:", err && err.message);
      break; // permission revoked, no microphone, or the OS took it: end cleanly
    } finally {
      try { recorder && recorder.release && recorder.release(); } catch { /* ignore */ }
    }
  }
}

// askConsent: async () => boolean, shown only if this device has not agreed before.
// Returns { handled, started, reason } where handled=false means "recording is
// not available, do whatever the app did before".
export async function startRideRecording({ token, rideId, askConsent, viaPanic = false }) {
  const cfg = await getRecordingEnabled(token);
  if (!cfg.enabled) return { handled: false };
  if (isRecordingRide(rideId)) return { handled: true, started: true };
  if (session) return { handled: true, started: false, reason: "busy" };

  // The Emergency Button records straight away, with no prompt (counsel, 9 Oct 2026).
  // A recording the person starts by themselves still asks for agreement first.
  if (!viaPanic && !(await hasStoredConsent())) {
    if (!askConsent || !(await askConsent())) return { handled: true, started: false, reason: "no_consent" };
    await storeConsent();
  }
  const perm = await AudioModule.requestRecordingPermissionsAsync();
  if (!perm.granted) return { handled: true, started: false, reason: "permission" };

  const { recording } = await api.startAudioRecording(token, rideId, viaPanic);
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true });

  const s = { token, rideId, recordingId: recording.id, stopRequested: false, wake: null, loop: null, queue: null };
  s.queue = createUploadQueue({ uploadChunk: (item) => uploadOne(s, item), onSent: (item) => deleteLocal(item.uri) });
  session = s;
  s.loop = recordLoop(s).finally(() => { if (session === s) finishSession(s); });
  notify();
  return { handled: true, started: true };
}

async function finishSession(s) {
  // Give the last pieces a short window to go out, then close the recording.
  await Promise.race([s.queue.flush(), new Promise((r) => setTimeout(r, 20000))]);
  try { await api.finishAudioRecording(s.token, s.recordingId); } catch { /* the server also ignores an unfinished recording after the trip */ }
  if (session === s) session = null;
  notify();
}

export async function stopRideRecording() {
  const s = session;
  if (!s) return;
  s.stopRequested = true;
  if (s.wake) s.wake();
  await s.loop;
}

// Emergency Button: start recording at once. It never asks in an emergency; the
// notice is given beforehand (pre-trip pop-up, policies, driver and vehicle owner
// agreements). Microphone permission still has to be granted on the phone, so
// the pre-trip pop-up should ask for it ahead of time.
export async function startOnPanic({ token, rideId }) {
  try {
    await startRideRecording({ token, rideId, viaPanic: true });
  } catch (err) {
    console.warn("Could not start recording on panic:", err && err.message);
  }
}
