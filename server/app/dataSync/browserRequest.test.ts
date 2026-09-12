import { describe, expect, test } from 'bun:test';
import { chromium, type Page, type Route } from 'playwright';

import {
  browserNativeHttpOnlyCookieHeader,
  browserNativeResponseBody,
  runBrowserNativeRequest,
  runBrowserNativeRouteRequest,
  safeBrowserRequestHeaders,
  type BrowserNativeRequest,
  type BrowserNativeResponse,
} from './browserRequest.ts';

describe('browser-native authenticated requests', () => {
  test('builds a bounded header from HttpOnly session cookies only', () => {
    expect(browserNativeHttpOnlyCookieHeader([
      { name: 'analytics', value: 'large-client-cookie', httpOnly: false },
      { name: 'session', value: 'session-token', httpOnly: true },
      { name: 'csrf', value: 'csrf-token', httpOnly: true },
    ])).toBe('session=session-token; csrf=csrf-token');
    expect(() => browserNativeHttpOnlyCookieHeader([
      { name: 'analytics', value: 'large-client-cookie', httpOnly: false },
    ])).toThrow('session cookies are unavailable');
    expect(() => browserNativeHttpOnlyCookieHeader([
      { name: 'invalid cookie', value: 'value', httpOnly: true },
    ])).toThrow('session cookie is invalid');
    expect(() => browserNativeHttpOnlyCookieHeader([
      { name: 'session', value: 'x'.repeat(3_501), httpOnly: true },
    ])).toThrow('cookie header is too large');
  });

  test('keeps replayable headers and leaves browser-owned headers to Chromium', () => {
    expect(safeBrowserRequestHeaders({
      accept: 'application/json',
      ':authority': 'example.test',
      ':method': 'POST',
      ':path': '/api',
      ':scheme': 'https',
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

  test('captures an intercepted same-origin route through the shared transport', async () => {
    const calls: Array<{ timeout?: number }> = [];
    let disposed = false;
    const page = {
      url: () => 'https://application.fixture.test/statements',
    } as unknown as Page;
    const route = {
      request: () => ({
        url: () => 'https://application.fixture.test/documents/one',
        method: () => 'GET',
      }),
      fetch: async (options: { timeout?: number }) => {
        calls.push(options);
        return {
          status: () => 200,
          url: () => 'https://application.fixture.test/documents/one',
          headers: () => ({ 'Content-Type': 'application/pdf' }),
          body: async () => Buffer.from('%PDF-synthetic'),
          dispose: async () => { disposed = true; },
        };
      },
    } as unknown as Route;

    await expect(runBrowserNativeRouteRequest(page, route, 15_000)).resolves.toEqual({
      status: 200,
      url: 'https://application.fixture.test/documents/one',
      headers: { 'content-type': 'application/pdf' },
      bodyBase64: Buffer.from('%PDF-synthetic').toString('base64'),
      redirected: false,
    });
    expect(calls).toEqual([{ timeout: 15_000 }]);
    expect(disposed).toBe(true);
  });

  test('rejects invalid intercepted routes before replay and cross-origin responses after disposal', async () => {
    let fetchCount = 0;
    let disposed = false;
    const page = {
      url: () => 'https://application.fixture.test/statements',
    } as unknown as Page;
    const crossOriginRequest = {
      request: () => ({
        url: () => 'https://outside.fixture.test/document',
        method: () => 'GET',
      }),
      fetch: async () => {
        fetchCount += 1;
        throw new Error('must not fetch');
      },
    } as unknown as Route;
    await expect(runBrowserNativeRouteRequest(page, crossOriginRequest)).rejects.toThrow(
      'must match the open application origin',
    );
    expect(fetchCount).toBe(0);

    const crossOriginResponse = {
      request: () => ({
        url: () => 'https://application.fixture.test/document',
        method: () => 'GET',
      }),
      fetch: async () => ({
        status: () => 302,
        url: () => 'https://outside.fixture.test/document',
        headers: () => ({}),
        body: async () => Buffer.alloc(0),
        dispose: async () => { disposed = true; },
      }),
    } as unknown as Route;
    await expect(runBrowserNativeRouteRequest(page, crossOriginResponse)).rejects.toThrow(
      'route response changed origin',
    );
    expect(disposed).toBe(true);
  });

  test('rewrites only the marked request when another request has the same URL and method', async () => {
    type PausedEvent = {
      requestId: string;
      request: { url: string; method: string; headers: Record<string, string> };
    };
    type PausedListener = (event: PausedEvent) => void;
    const targetUrl = 'https://application.fixture.test/document';
    const commands: Array<{ method: string; parameters?: Record<string, unknown> }> = [];
    let pausedListener: PausedListener | undefined;
    const cdp = {
      on(method: string, listener: PausedListener) {
        expect(method).toBe('Fetch.requestPaused');
        pausedListener = listener;
      },
      off(method: string, listener: PausedListener) {
        expect(method).toBe('Fetch.requestPaused');
        expect(pausedListener === listener).toBe(true);
        pausedListener = undefined;
      },
      async send(method: string, parameters?: Record<string, unknown>) {
        commands.push({ method, ...(parameters ? { parameters } : {}) });
      },
      async detach() {
        commands.push({ method: 'detach' });
      },
    };
    const page = {
      url: () => 'https://application.fixture.test/application',
      context: () => ({
        cookies: async () => [
          { name: 'session', value: 'session-token', httpOnly: true },
          { name: 'analytics', value: 'large-client-cookie', httpOnly: false },
        ],
        newCDPSession: async () => cdp,
      }),
      evaluate: async (
        _callback: unknown,
        request: BrowserNativeRequest & { applicationOrigin: string; destinationOrigin: string },
      ): Promise<BrowserNativeResponse> => {
        const marker = Object.entries(request.headers ?? {})
          .find(([name]) => name.toLowerCase() === 'x-easymoney-browser-request')?.[1];
        expect(marker).toBeString();
        pausedListener?.({
          requestId: 'background',
          request: {
            url: targetUrl,
            method: 'GET',
            headers: { cookie: 'session=session-token; analytics=large-client-cookie' },
          },
        });
        pausedListener?.({
          requestId: 'target',
          request: {
            url: targetUrl,
            method: 'GET',
            headers: {
              cookie: 'session=session-token; analytics=large-client-cookie',
              'X-EasyMoney-Browser-Request': marker!,
            },
          },
        });
        await Promise.resolve();
        return {
          status: 200,
          url: targetUrl,
          headers: { 'content-type': 'application/pdf' },
          bodyBase64: 'AAE=',
          redirected: false,
        };
      },
    } as unknown as Page;

    await expect(runBrowserNativeRequest(page, {
      url: targetUrl,
      method: 'GET',
      cookiePolicy: 'http-only',
    })).resolves.toMatchObject({ status: 200, url: targetUrl });

    expect(commands[0]).toEqual({
      method: 'Fetch.enable',
      parameters: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
    });
    expect(commands.filter(command => command.method === 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', parameters: { requestId: 'background' } },
      {
        method: 'Fetch.continueRequest',
        parameters: {
          requestId: 'target',
          headers: [{ name: 'cookie', value: 'session=session-token' }],
        },
      },
    ]);
    expect(commands.slice(-2)).toEqual([{ method: 'Fetch.disable' }, { method: 'detach' }]);
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

  test('uses Chromium networking with only HttpOnly cookies and leaves the browser jar unchanged', async () => {
    const observations: Array<{
      accept: string | null;
      cookie: string | null;
      marker: string | null;
    }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/document') {
          observations.push({
            accept: request.headers.get('accept'),
            cookie: request.headers.get('cookie'),
            marker: request.headers.get('x-easymoney-browser-request'),
          });
          return new Response('%PDF-1.7\n%%EOF', {
            headers: {
              'content-type': 'application/pdf',
              'set-cookie': 'rotated-session=accepted; Path=/; HttpOnly; SameSite=Lax',
            },
          });
        }
        return new Response('<!doctype html><title>Application</title>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: 'session', value: 'session-token', url: origin, httpOnly: true },
        { name: 'analytics', value: 'large-client-cookie', url: origin },
      ]);
      const page = await context.newPage();
      await page.goto(`${origin}/application`, { waitUntil: 'domcontentloaded' });

      const response = await runBrowserNativeRequest(page, {
        url: `${origin}/document`,
        method: 'GET',
        headers: {
          accept: '*/*',
          cookie: 'spoofed=blocked',
        },
        cookiePolicy: 'http-only',
      });

      expect(response).toMatchObject({
        status: 200,
        url: `${origin}/document`,
        headers: { 'content-type': 'application/pdf' },
        redirected: false,
      });
      expect(browserNativeResponseBody(response)).toEqual(Buffer.from('%PDF-1.7\n%%EOF'));
      expect(observations).toEqual([{
        accept: '*/*',
        cookie: 'session=session-token',
        marker: null,
      }]);
      expect((await context.cookies(origin)).map(cookie => cookie.name).sort())
        .toEqual(['analytics', 'rotated-session', 'session']);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  }, 30_000);
});
