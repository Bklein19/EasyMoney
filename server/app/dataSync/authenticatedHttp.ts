import type { APIResponse, Page } from 'playwright';

import { safeBrowserRequestHeaders } from './browserRequest.ts';

export type AuthenticatedHttpRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  form?: Record<string, string | number | boolean>;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type AuthenticatedHttpRedirect = {
  status: number;
  fromUrl: string;
  toUrl: string;
};

export type AuthenticatedHttpResponse = {
  requestUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  redirects: AuthenticatedHttpRedirect[];
};

export type AuthenticatedHttpContentTypeExpectation = string | RegExp;

export type AuthenticatedHttpBodyExpectation = {
  minimumBytes?: number;
  startsWith?: readonly (string | Uint8Array)[];
  validate?: (body: Buffer) => boolean;
};

export type AuthenticatedHttpResponseExpectation = {
  status?: number | readonly number[] | ((status: number) => boolean);
  contentTypes?: readonly AuthenticatedHttpContentTypeExpectation[];
  body?: AuthenticatedHttpBodyExpectation;
  isLoginUrl?: (url: URL) => boolean;
};

type AuthenticatedHttpPage = Pick<Page, 'request' | 'url'>;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function requestTimeout(timeoutMs: number | undefined): number {
  const timeout = timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 5 * 60_000) {
    throw new Error('Authenticated HTTP request timeout is invalid');
  }
  return timeout;
}

function requestRedirectLimit(maxRedirects: number | undefined): number {
  const limit = maxRedirects ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 20) {
    throw new Error('Authenticated HTTP redirect limit is invalid');
  }
  return limit;
}

function requestMethod(method: string | undefined): string {
  const value = (method ?? 'GET').trim().toUpperCase();
  if (!value || !/^[A-Z]+$/.test(value)) {
    throw new Error('Authenticated HTTP request method is invalid');
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(hostname) || hostname.endsWith('.localhost');
}

function assertHttpApplicationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Authenticated HTTP request requires an open application URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Authenticated HTTP application URL must be secure');
  }
  return url;
}

export function authenticatedHttpSameOriginUrl(candidate: string, applicationUrl: string): URL {
  const application = assertHttpApplicationUrl(applicationUrl);
  let target: URL;
  try {
    target = new URL(candidate, application);
  } catch {
    throw new Error('Authenticated HTTP request URL is invalid');
  }
  if (target.origin !== application.origin ||
      (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopbackHostname(target.hostname)))) {
    throw new Error('Authenticated HTTP request must stay on the open application origin');
  }
  return target;
}

function redirectTarget(response: APIResponse, applicationUrl: string): URL | null {
  if (!redirectStatuses.has(response.status())) return null;
  const location = response.headersArray()
    .find(header => header.name.toLowerCase() === 'location')?.value;
  if (!location) return null;
  const responseUrl = authenticatedHttpSameOriginUrl(response.url(), applicationUrl);
  const target = new URL(location, responseUrl);
  return authenticatedHttpSameOriginUrl(target.toString(), applicationUrl);
}

function redirectedRequest(
  status: number,
  method: string,
  headers: Record<string, string>,
  body: string | Buffer | undefined,
  form: Record<string, string | number | boolean> | undefined,
  referrer: string,
): {
  method: string;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
  form: Record<string, string | number | boolean> | undefined;
} {
  const switchToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
  const nextHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'),
  );
  nextHeaders.referer = referrer;
  if (switchToGet) {
    for (const name of Object.keys(nextHeaders)) {
      if (['content-type', 'origin'].includes(name.toLowerCase())) delete nextHeaders[name];
    }
    return { method: 'GET', headers: nextHeaders, body: undefined, form: undefined };
  }
  return { method, headers: nextHeaders, body, form };
}

function normalizedResponseHeaders(response: APIResponse): Record<string, string> {
  return Object.fromEntries(response.headersArray().map(header => [header.name.toLowerCase(), header.value]));
}

export async function runAuthenticatedHttpRequest(
  page: AuthenticatedHttpPage,
  request: AuthenticatedHttpRequest,
): Promise<AuthenticatedHttpResponse> {
  if (request.body !== undefined && request.form !== undefined) {
    throw new Error('Authenticated HTTP request has multiple request bodies');
  }
  const applicationUrl = page.url();
  const requestUrl = authenticatedHttpSameOriginUrl(request.url, applicationUrl).toString();
  const timeout = requestTimeout(request.timeoutMs);
  const maxRedirects = requestRedirectLimit(request.maxRedirects);
  let currentUrl = requestUrl;
  let method = requestMethod(request.method);
  let headers = safeBrowserRequestHeaders(request.headers ?? {});
  if (!['GET', 'HEAD'].includes(method)) headers.origin = new URL(applicationUrl).origin;
  let body = request.body;
  let form = request.form;
  const redirects: AuthenticatedHttpRedirect[] = [];

  while (true) {
    let response: APIResponse | undefined;
    try {
      response = await page.request.fetch(currentUrl, {
        method,
        headers,
        ...(body !== undefined ? { data: body } : {}),
        ...(form !== undefined ? { form } : {}),
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout,
      });
      authenticatedHttpSameOriginUrl(response.url(), applicationUrl);
      const nextUrl = redirectTarget(response, applicationUrl);
      if (nextUrl) {
        if (redirects.length >= maxRedirects) {
          throw new Error('Authenticated HTTP request exceeded its redirect limit');
        }
        redirects.push({
          status: response.status(),
          fromUrl: currentUrl,
          toUrl: nextUrl.toString(),
        });
        ({ method, headers, body, form } = redirectedRequest(
          response.status(),
          method,
          headers,
          body,
          form,
          currentUrl,
        ));
        currentUrl = nextUrl.toString();
        continue;
      }
      return {
        requestUrl,
        finalUrl: new URL(response.url(), currentUrl).toString(),
        status: response.status(),
        statusText: response.statusText(),
        headers: normalizedResponseHeaders(response),
        body: await response.body(),
        redirects,
      };
    } finally {
      await response?.dispose();
    }
  }
}

export function authenticatedHttpContentType(response: AuthenticatedHttpResponse): string {
  return (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

export function authenticatedHttpResponseIsLoginRedirect(
  response: AuthenticatedHttpResponse,
  isLoginUrl: (url: URL) => boolean,
): boolean {
  if (response.status === 401 || response.status === 403) return true;
  const urls = [
    ...response.redirects.map(redirect => redirect.toUrl),
    response.finalUrl,
  ];
  return urls.some(value => {
    try {
      return isLoginUrl(new URL(value));
    } catch {
      return true;
    }
  });
}

export function assertAuthenticatedHttpStatus(
  response: AuthenticatedHttpResponse,
  expected: number | readonly number[] | ((status: number) => boolean) = status => status >= 200 && status < 300,
): void {
  const valid = typeof expected === 'function'
    ? expected(response.status)
    : typeof expected === 'number'
      ? response.status === expected
      : expected.includes(response.status);
  if (!valid) throw new Error(`Authenticated HTTP response status ${response.status} was not accepted`);
}

export function assertAuthenticatedHttpContentType(
  response: AuthenticatedHttpResponse,
  expected: readonly AuthenticatedHttpContentTypeExpectation[],
): string {
  if (expected.length === 0) throw new Error('Authenticated HTTP content-type expectation is empty');
  const contentType = authenticatedHttpContentType(response);
  const valid = expected.some(expectation => typeof expectation === 'string'
    ? contentType === expectation.toLowerCase()
    : expectation.test(contentType));
  if (!valid) {
    throw new Error(
      `Authenticated HTTP response content type "${contentType || '<missing>'}" was not accepted`,
    );
  }
  return contentType;
}

function startsWith(body: Buffer, signature: string | Uint8Array): boolean {
  const bytes = typeof signature === 'string' ? Buffer.from(signature) : Buffer.from(signature);
  return body.length >= bytes.length && body.subarray(0, bytes.length).equals(bytes);
}

export function assertAuthenticatedHttpBody(
  response: AuthenticatedHttpResponse,
  expectation: AuthenticatedHttpBodyExpectation = {},
): Buffer {
  const minimumBytes = expectation.minimumBytes ?? 1;
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0) {
    throw new Error('Authenticated HTTP body expectation is invalid');
  }
  if (response.body.length < minimumBytes) {
    throw new Error('Authenticated HTTP response body is too small');
  }
  if (expectation.startsWith && expectation.startsWith.length > 0 &&
      !expectation.startsWith.some(signature => startsWith(response.body, signature))) {
    throw new Error('Authenticated HTTP response body signature was not accepted');
  }
  if (expectation.validate && !expectation.validate(response.body)) {
    throw new Error('Authenticated HTTP response body was not accepted');
  }
  return response.body;
}

export function assertAuthenticatedHttpResponse(
  response: AuthenticatedHttpResponse,
  expectation: AuthenticatedHttpResponseExpectation = {},
): Buffer {
  if (expectation.isLoginUrl && authenticatedHttpResponseIsLoginRedirect(response, expectation.isLoginUrl)) {
    throw new Error('Authenticated HTTP response requires authentication');
  }
  assertAuthenticatedHttpStatus(response, expectation.status);
  if (expectation.contentTypes) assertAuthenticatedHttpContentType(response, expectation.contentTypes);
  return assertAuthenticatedHttpBody(response, expectation.body);
}
