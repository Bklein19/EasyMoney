import { describe, expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright';

import {
  browserNativeResponseBody,
  runBrowserNativeRequest,
  safeBrowserRequestHeaders,
  type BrowserNativeResponse,
} from './browserRequest.ts';

describe('browser-native authenticated requests', () => {
  test('keeps replayable headers and leaves browser-owned headers to Chromium', () => {
    expect(safeBrowserRequestHeaders({
      accept: 'application/json',
      cookie: 'private=value',
      host: 'invalid.example',
      origin: 'https://invalid.example',
      referer: 'https://example.test/application',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'custom-agent',
      'x-request-proof': 'preserved',
    })).toEqual({
      accept: 'application/json',
      referer: 'https://example.test/application',
      'x-request-proof': 'preserved',
    });
  });

  test('normalizes a relative response URL without parsing response cookies in Bun', async () => {
    const page = {
      url: () => 'https://digital.example.test/application',
      evaluate: async () => ({
        status: 200,
        url: '/api/activity',
        headers: {
          'content-type': 'application/octet-stream',
          'set-cookie': 'browser-owned=accepted; Path=/',
        },
        bodyBase64: 'AAE=',
        redirected: false,
      } satisfies BrowserNativeResponse),
    } as unknown as Page;

    await expect(runBrowserNativeRequest(page, {
      url: 'https://digital.example.test/api/activity',
      method: 'GET',
    })).resolves.toEqual({
      status: 200,
      url: 'https://digital.example.test/api/activity',
      headers: {
        'content-type': 'application/octet-stream',
        'set-cookie': 'browser-owned=accepted; Path=/',
      },
      bodyBase64: 'AAE=',
      redirected: false,
    });
  });

  test('rejects cross-origin requests before exposing browser cookies', async () => {
    let evaluated = false;
    const page = {
      url: () => 'https://accounts.example.test/application',
      evaluate: async () => {
        evaluated = true;
        throw new Error('must not evaluate');
      },
    } as unknown as Page;

    await expect(runBrowserNativeRequest(page, {
      url: 'https://outside.example.test/api',
      method: 'GET',
    })).rejects.toThrow('must match the open application origin');
    expect(evaluated).toBe(false);

    await expect(runBrowserNativeRequest(page, {
      url: 'https://outside.example.test/api',
      method: 'GET',
    }, {
      applicationOrigin: 'https://accounts.example.test',
      destinationOrigin: 'https://outside.example.test',
      institutionHostname: 'accounts.example.test',
    })).rejects.toThrow('does not approve this institution request');
    expect(evaluated).toBe(false);
  });

  test('preserves POST bytes, safe headers, referrer, forms, response bytes, and browser cookies in Chromium', async () => {
    const responseBytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const requestBytes = Uint8Array.from([255, 0, 42, 128]);
    const observations: Array<Record<string, unknown>> = [];
    const origin = 'https://application.fixture.test';
    const crossOrigin = 'https://destination.fixture.test';
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = await request.allHeaders();
        if (request.method() === 'OPTIONS') {
          await route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-credentials': 'true',
              'access-control-allow-headers': 'x-request-proof',
              'access-control-allow-methods': 'POST',
              'access-control-allow-origin': origin,
            },
          });
          return;
        }
        if (url.pathname === '/cross-origin') {
          observations.push({
            kind: 'cross-origin',
            cookie: headers.cookie ?? null,
            proof: headers['x-request-proof'] ?? null,
            referrer: headers.referer ?? null,
            body: [...(request.postDataBuffer() ?? Buffer.alloc(0))],
          });
          await route.fulfill({
            status: 200,
            headers: {
              'access-control-allow-credentials': 'true',
              'access-control-allow-origin': origin,
              'content-type': 'application/octet-stream',
            },
            body: Buffer.from(responseBytes),
          });
          return;
        }
        if (url.pathname === '/replay') {
          observations.push({
            kind: 'replay',
            method: request.method(),
            contentType: headers['content-type'] ?? null,
            cookie: headers.cookie ?? null,
            proof: headers['x-request-proof'] ?? null,
            referrer: headers.referer ?? null,
            body: [...(request.postDataBuffer() ?? Buffer.alloc(0))],
          });
          await route.fulfill({
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'set-cookie': 'rotated-session=accepted; Path=/; SameSite=Lax',
            },
            body: Buffer.from(responseBytes),
          });
          return;
        }
        if (url.pathname === '/form') {
          observations.push({
            kind: 'form',
            contentType: headers['content-type'] ?? null,
            fields: Object.fromEntries(new URLSearchParams(request.postData() ?? '')),
          });
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{"accepted":true}' });
          return;
        }
        if (url.pathname === '/multipart') {
          const body = request.postData() ?? '';
          const formValue = (name: string) => body.match(
            new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`),
          )?.[1];
          observations.push({
            kind: 'multipart',
            contentType: headers['content-type'] ?? null,
            fields: { account: formValue('account'), format: formValue('format') },
          });
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{"accepted":true}' });
          return;
        }
        if (url.pathname === '/redirect') {
          await route.fulfill({
            status: 302,
            headers: {
              location: '/login',
              'set-cookie': 'redirect-session=accepted; Path=/; SameSite=Lax',
            },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'existing-session=accepted; Path=/; SameSite=Lax',
          },
          body: '<!doctype html><title>Browser request fixture</title>',
        });
      });
      await page.goto(`${origin}/application`, { waitUntil: 'domcontentloaded' });

      const response = await runBrowserNativeRequest(page, {
        url: `${origin}/replay`,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          cookie: 'spoofed-session=blocked',
          referer: `${origin}/activity`,
          'x-request-proof': 'preserved',
        },
        bodyBase64: Buffer.from(requestBytes).toString('base64'),
      });
      expect(observations[0]).toEqual({
        kind: 'replay',
        method: 'POST',
        contentType: 'application/octet-stream',
        cookie: 'existing-session=accepted',
        proof: 'preserved',
        referrer: `${origin}/activity`,
        body: [...requestBytes],
      });
      expect(response).toMatchObject({ status: 200, url: `${origin}/replay`, redirected: false });
      expect(browserNativeResponseBody(response)).toEqual(Buffer.from(responseBytes));

      await runBrowserNativeRequest(page, {
        url: `${origin}/form`,
        method: 'POST',
        form: { account: 'example', range: 'recent' },
      });
      await runBrowserNativeRequest(page, {
        url: `${origin}/multipart`,
        method: 'POST',
        multipart: { account: 'example', format: 'csv' },
      });
      expect(observations[1]).toEqual({
        kind: 'form',
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
        fields: { account: 'example', range: 'recent' },
      });
      expect(observations[2]).toEqual({
        kind: 'multipart',
        contentType: expect.stringMatching(/^multipart\/form-data; boundary=/),
        fields: { account: 'example', format: 'csv' },
      });

      const crossOriginResponse = await runBrowserNativeRequest(page, {
        url: `${crossOrigin}/cross-origin`,
        method: 'POST',
        headers: {
          referer: `${origin}/`,
          'x-request-proof': 'cross-origin-preserved',
        },
        bodyBase64: Buffer.from(requestBytes).toString('base64'),
      }, {
        applicationOrigin: origin,
        destinationOrigin: crossOrigin,
        institutionHostname: 'fixture.test',
      });
      expect(observations[3]).toEqual({
        kind: 'cross-origin',
        cookie: null,
        proof: 'cross-origin-preserved',
        referrer: `${origin}/`,
        body: [...requestBytes],
      });
      expect(browserNativeResponseBody(crossOriginResponse)).toEqual(Buffer.from(responseBytes));

      const redirect = await runBrowserNativeRequest(page, {
        url: `${origin}/redirect`,
        method: 'GET',
      });
      expect(redirect).toMatchObject({ status: 0, redirected: true });
      const cookies = await context.cookies([origin, crossOrigin]);
      expect(cookies.some(cookie => cookie.name === 'rotated-session' && cookie.value === 'accepted')).toBe(true);
      expect(cookies.some(cookie => cookie.name === 'redirect-session' && cookie.value === 'accepted')).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
