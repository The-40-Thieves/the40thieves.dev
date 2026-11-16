import { describe, expect, it } from 'vitest';

import { sentryOptions } from '../src/lib/sentry-options.ts';

describe('sentryOptions', () => {
  it('leaves dsn unset when SENTRY_DSN is absent', () => {
    const options = sentryOptions({});
    expect(options).not.toHaveProperty('dsn');
    expect(options.environment).toBe('development');
    expect(options.tracesSampleRate).toBe(0);
  });

  it('treats an empty SENTRY_DSN as unset, so e2e and local runs report nothing', () => {
    expect(sentryOptions({ SENTRY_DSN: '' })).not.toHaveProperty('dsn');
  });

  it('passes dsn, environment and release through when set', () => {
    const options = sentryOptions({
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'abc123',
    });
    expect(options.dsn).toBe('https://key@o1.ingest.us.sentry.io/1');
    expect(options.environment).toBe('production');
    expect(options.release).toBe('abc123');
  });

  it('collects no PII', () => {
    expect(sentryOptions({}).dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    });
  });
});
