import { POSTHOG_CAPTURE_URL, pageviewEvent } from '../lib/analytics.ts';

/**
 * Send one anonymous page view. Skipped when the browser asks not to be tracked (Global
 * Privacy Control or Do Not Track) and on non-production hosts, so previews and local runs
 * never reach the shared PostHog project.
 */
function sendPageview(): void {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1') return;
  if (location.hostname !== 'the40thieves.dev') return;
  const event = pageviewEvent({
    url: location.href,
    referrer: document.referrer,
    // One id per page load: enough for counts and funnels by host, no cross-visit linking.
    distinctId: crypto.randomUUID(),
    now: new Date().toISOString(),
  });
  const body = JSON.stringify(event);
  if (!navigator.sendBeacon(POSTHOG_CAPTURE_URL, new Blob([body], { type: 'text/plain' }))) {
    void fetch(POSTHOG_CAPTURE_URL, { method: 'POST', body, keepalive: true });
  }
}

sendPageview();
