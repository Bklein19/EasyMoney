import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chromium, type APIRequestContext } from 'playwright';

import {
  assertAuthenticatedHttpBody,
  assertAuthenticatedHttpContentType,
  assertAuthenticatedHttpResponse,
  assertAuthenticatedHttpStatus,
  authenticatedHttpContentType,
  authenticatedHttpResponseIsLoginRedirect,
  authenticatedHttpSameOriginUrl,
  runAuthenticatedHttpRequest,
  type AuthenticatedHttpResponse,
} from './authenticatedHttp.ts';

function response(overrides: Partial<AuthenticatedHttpResponse> = {}): AuthenticatedHttpResponse {
  return {
    requestUrl: 'https://application.example.test/activity',
    finalUrl: 'https://application.example.test/activity.csv',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/csv; charset=utf-8' },
    body: Buffer.from('Date,Description,Amount\n'),
    redirects: [],
    ...overrides,
  };
}

describe('authenticated HTTP transport', () => {
  test('resolves relative URLs and rejects insecure or cross-origin targets', () => {
    expect(authenticatedHttpSameOriginUrl(
      '../activity?range=year',
      'https://application.example.test/history/current',
    ).toString()).toBe('https://application.example.test/activity?range=year');
    expect(() => authenticatedHttpSameOriginUrl(
      'https://outside.example.test/activity',
      'https://application.example.test/history',
    )).toThrow('stay on the open application origin');
    expect(() => authenticatedHttpSameOriginUrl(
      '/activity',
      'http://application.example.test/history',
    )).toThrow('must be secure');
    expect(authenticatedHttpSameOriginUrl(
      '/activity',
      'http://127.0.0.1:3100/history',
    ).toString()).toBe('http://127.0.0.1:3100/activity');
  });

  test('validates status, content type, body size, signature, and custom structure', () => {
    const csv = response();
    expect(authenticatedHttpContentType(csv)).toBe('text/csv');
    expect(assertAuthenticatedHttpContentType(csv, ['text/csv', /excel/])).toBe('text/csv');
    expect(assertAuthenticatedHttpBody(csv, {
      minimumBytes: 10,
      startsWith: ['Date,'],
      validate: body => body.includes(Buffer.from('Amount')),
    })).toBe(csv.body);
    expect(assertAuthenticatedHttpResponse(csv, {
      status: [200, 206],
      contentTypes: [/csv/],
      body: { minimumBytes: 10, startsWith: ['Date,'] },
    })).toBe(csv.body);

    expect(() => assertAuthenticatedHttpStatus(response({ status: 500 }))).toThrow('status 500');
    expect(() => assertAuthenticatedHttpContentType(response({
      headers: { 'content-type': 'text/html' },
    }), ['text/csv'])).toThrow('content type "text/html" was not accepted');
    expect(() => assertAuthenticatedHttpBody(response({ body: Buffer.alloc(0) }))).toThrow('too small');
    expect(() => assertAuthenticatedHttpBody(csv, { startsWith: ['%PDF-'] })).toThrow('signature');
    expect(() => assertAuthenticatedHttpBody(csv, { validate: () => false })).toThrow('body was not accepted');
  });

  test('recognizes authentication status and any login URL in the redirect chain', () => {
    const isLoginUrl = (url: URL) => url.pathname === '/login';
    expect(authenticatedHttpResponseIsLoginRedirect(response({ status: 401 }), isLoginUrl)).toBe(true);
    expect(authenticatedHttpResponseIsLoginRedirect(response({
      redirects: [{
        status: 302,
        fromUrl: 'https://application.example.test/activity',
        toUrl: 'https://application.example.test/login',
      }],
    }), isLoginUrl)).toBe(true);
    expect(authenticatedHttpResponseIsLoginRedirect(response(), isLoginUrl)).toBe(false);
    expect(() => assertAuthenticatedHttpResponse(response({
      redirects: [{
        status: 302,
        fromUrl: 'https://application.example.test/activity',
        toUrl: 'https://application.example.test/login',
      }],
    }), { isLoginUrl })).toThrow('requires authentication');
  });

  test('shares cookies, follows same-origin redirects, and blocks cross-origin redirects before sending them', async () => {
    let outsideRequests = 0;
    const outside = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        outsideRequests += 1;
        return new Response('must not be reached');
      },
    });
    const observations: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/folder/export') {
          observations.push({
            path: url.pathname,
            cookie: request.headers.get('cookie'),
            method: request.method,
            origin: request.headers.get('origin'),
            body: await request.text(),
          });
          return new Response(null, {
            status: 302,
            headers: {
              location: 'download',
              'set-cookie': 'rotated=accepted; Path=/; SameSite=Lax',
            },
          });
        }
        if (url.pathname === '/folder/download') {
          observations.push({
            path: url.pathname,
            cookie: request.headers.get('cookie'),
            method: request.method,
            origin: request.headers.get('origin'),
            referrer: request.headers.get('referer'),
          });
          return new Response('Date,Description,Amount\n', {
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          });
        }
        if (url.pathname === '/outside') {
          return new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${outside.port}/escaped` },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{
        name: 'authenticated',
        value: 'yes',
        url: origin,
      }]);
      const page = {
        request: context.request,
        url: () => `${origin}/history`,
      } as { request: APIRequestContext; url: () => string };

      const csv = await runAuthenticatedHttpRequest(page, {
        url: '/folder/export',
        method: 'POST',
        headers: {
          cookie: 'spoofed=blocked',
          origin: 'https://outside.example.test',
          'content-type': 'application/x-www-form-urlencoded',
          Referer: `${origin}/history`,
          'x-request-proof': 'preserved',
        },
        form: { range: 'year' },
      });
      expect(csv).toMatchObject({
        requestUrl: `${origin}/folder/export`,
        finalUrl: `${origin}/folder/download`,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/csv; charset=utf-8' },
        redirects: [{
          status: 302,
          fromUrl: `${origin}/folder/export`,
          toUrl: `${origin}/folder/download`,
        }],
      });
      expect(csv.body).toEqual(Buffer.from('Date,Description,Amount\n'));
      expect(observations).toEqual([
        {
          path: '/folder/export',
          cookie: 'authenticated=yes',
          method: 'POST',
          origin,
          body: 'range=year',
        },
        {
          path: '/folder/download',
          cookie: 'authenticated=yes; rotated=accepted',
          method: 'GET',
          origin: null,
          referrer: `${origin}/folder/export`,
        },
      ]);
      expect((await context.cookies(origin)).some(cookie =>
        cookie.name === 'rotated' && cookie.value === 'accepted'
      )).toBe(true);

      await expect(runAuthenticatedHttpRequest(page, { url: '/outside' }))
        .rejects.toThrow('stay on the open application origin');
      expect(outsideRequests).toBe(0);
    } finally {
      await browser.close();
      await server.stop(true);
      await outside.stop(true);
    }
  }, 30_000);

  test('uses Playwright request context without page evaluation or DOM access', () => {
    const source = readFileSync(new URL('./authenticatedHttp.ts', import.meta.url), 'utf8');
    expect(source).toContain('page.request.fetch');
    expect(source).not.toContain('page.evaluate');
    expect(source).not.toMatch(/\b(?:locator|querySelector|document)\b/);
  });
});
