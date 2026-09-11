import type { CDPSession, Page } from 'playwright';

export type BrowserNativeRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  cookiePolicy?: 'browser' | 'http-only';
  bodyBase64?: string;
  form?: Record<string, string>;
  multipart?: Record<string, string>;
  timeoutMs?: number;
};

export type BrowserNativeResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string;
  redirected: boolean;
};

export type BrowserNativeCrossOriginPolicy = {
  applicationOrigin: string;
  destinationOrigin: string;
  institutionHostname: string;
};

type BrowserNativePageRequest = BrowserNativeRequest & {
  applicationOrigin: string;
  destinationOrigin: string;
};

type BrowserNativeCookie = {
  name: string;
  value: string;
  httpOnly: boolean;
};

type BrowserRequestPausedEvent = {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
};

const browserOwnedRequestHeaders = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'origin',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
]);
const compactCookieRequestMarkerHeader = 'x-easymoney-browser-request';

function isBrowserOwnedRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return browserOwnedRequestHeaders.has(normalized) || normalized.startsWith('sec-fetch-') || normalized.startsWith(':');
}

export function safeBrowserRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isBrowserOwnedRequestHeader(name)));
}

export function browserNativeHttpOnlyCookieHeader(cookies: readonly BrowserNativeCookie[]): string {
  const eligible = cookies.filter(cookie => cookie.httpOnly);
  if (eligible.length === 0) throw new Error('Browser-native authenticated session cookies are unavailable');
  for (const cookie of eligible) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) || /[;\r\n]/.test(cookie.value)) {
      throw new Error('Browser-native authenticated session cookie is invalid');
    }
  }
  const header = eligible.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (Buffer.byteLength(header) > 3_500) {
    throw new Error('Browser-native authenticated session cookie header is too large');
  }
  return header;
}

function validatedRequestOrigins(
  request: BrowserNativeRequest,
  pageUrl: string,
  crossOriginPolicy?: BrowserNativeCrossOriginPolicy,
): { applicationOrigin: string; destinationOrigin: string } {
  const url = new URL(request.url);
  const current = new URL(pageUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Browser-native request must match the open application origin');
  }
  if (url.origin === current.origin) {
    if (crossOriginPolicy) throw new Error('Browser-native cross-origin policy is unnecessary');
    return { applicationOrigin: current.origin, destinationOrigin: url.origin };
  }
  if (!crossOriginPolicy) {
    throw new Error('Browser-native request must match the open application origin');
  }
  const applicationOrigin = new URL(crossOriginPolicy.applicationOrigin);
  const destinationOrigin = new URL(crossOriginPolicy.destinationOrigin);
  const institutionHostname = crossOriginPolicy.institutionHostname.toLowerCase();
  const isLoopbackHostname = (hostname: string) => /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(hostname) ||
    hostname.endsWith('.localhost');
  const isSecureOrLoopback = (url: URL) => url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
  const isInstitutionHostname = (hostname: string) => (
    hostname === institutionHostname || hostname.endsWith(`.${institutionHostname}`)
  );
  if ((!institutionHostname.includes('.') && institutionHostname !== 'localhost') ||
    applicationOrigin.origin !== crossOriginPolicy.applicationOrigin ||
    destinationOrigin.origin !== crossOriginPolicy.destinationOrigin ||
    !isSecureOrLoopback(applicationOrigin) || !isSecureOrLoopback(destinationOrigin) ||
    current.origin !== applicationOrigin.origin || url.origin !== destinationOrigin.origin ||
    !isInstitutionHostname(applicationOrigin.hostname) || !isInstitutionHostname(destinationOrigin.hostname)) {
    throw new Error('Browser-native cross-origin policy does not approve this institution request');
  }
  return { applicationOrigin: applicationOrigin.origin, destinationOrigin: destinationOrigin.origin };
}

function validateBrowserNativeRequest(request: BrowserNativeRequest): void {
  if (!request.method.trim()) throw new Error('Browser-native request requires an HTTP method');
  const bodyVariants = [request.bodyBase64, request.form, request.multipart]
    .filter(value => value !== undefined).length;
  if (bodyVariants > 1) throw new Error('Browser-native request has multiple request bodies');
  if (request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 5 * 60_000)) {
    throw new Error('Browser-native request timeout is invalid');
  }
  if (request.cookiePolicy !== undefined &&
    request.cookiePolicy !== 'browser' && request.cookiePolicy !== 'http-only') {
    throw new Error('Browser-native request cookie policy is invalid');
  }
}

async function runWithHttpOnlyBrowserCookies<T>(
  page: Page,
  request: BrowserNativeRequest,
  operation: (request: BrowserNativeRequest) => Promise<T>,
): Promise<T> {
  const targetUrl = new URL(request.url).toString();
  const cookieHeader = browserNativeHttpOnlyCookieHeader(
    await page.context().cookies(targetUrl),
  );
  const requestMarker = crypto.randomUUID();
  const markedRequest: BrowserNativeRequest = {
    ...request,
    headers: {
      ...request.headers,
      [compactCookieRequestMarkerHeader]: requestMarker,
    },
  };
  let intercepted = false;
  let interceptionError: unknown;
  const pending = new Set<Promise<void>>();
  const cdp: CDPSession = await page.context().newCDPSession(page);

  const handlePausedRequest = async (event: BrowserRequestPausedEvent): Promise<void> => {
    const marker = Object.entries(event.request.headers)
      .find(([name]) => name.toLowerCase() === compactCookieRequestMarkerHeader)?.[1];
    const isTarget = marker === requestMarker &&
      new URL(event.request.url).toString() === targetUrl &&
      event.request.method.toUpperCase() === request.method.trim().toUpperCase();
    try {
      if (!isTarget) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        return;
      }
      intercepted = true;
      const headers = Object.entries(event.request.headers)
        .filter(([name]) => !['cookie', compactCookieRequestMarkerHeader].includes(name.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      headers.push({ name: 'cookie', value: cookieHeader });
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId, headers });
    } catch (error) {
      if (isTarget) interceptionError = error;
      await cdp.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'Failed',
      }).catch(() => {});
    }
  };
  const onPausedRequest = (event: BrowserRequestPausedEvent) => {
    const task = handlePausedRequest(event);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };

  cdp.on('Fetch.requestPaused', onPausedRequest);
  try {
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(markedRequest);
    } catch (error) {
      operationError = error;
    }
    await Promise.allSettled([...pending]);
    if (interceptionError) throw interceptionError;
    if (operationError) throw operationError;
    if (!intercepted) throw new Error('Browser-native compact cookie request was not intercepted');
    return result as T;
  } finally {
    await cdp.send('Fetch.disable').catch(() => {});
    cdp.off('Fetch.requestPaused', onPausedRequest);
    await Promise.allSettled([...pending]);
    await cdp.detach().catch(() => {});
  }
}

async function browserNativeFetchInPage(
  request: BrowserNativePageRequest,
): Promise<BrowserNativeResponse> {
  const target = new URL(request.url, location.href);
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') ||
    location.origin !== request.applicationOrigin || target.origin !== request.destinationOrigin) {
    throw new Error('Browser-native request origin changed before execution');
  }

  const headers = new Headers();
  let requestedReferrer: string | undefined;
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (name === 'referer') {
      requestedReferrer = value;
      continue;
    }
    if ([
      'accept-encoding',
      'connection',
      'content-length',
      'cookie',
      'host',
      'keep-alive',
      'origin',
      'proxy-connection',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'user-agent',
    ].includes(name) || name.startsWith('sec-fetch-') || name.startsWith(':')) continue;
    headers.set(rawName, value);
  }

  let referrer: string | undefined;
  if (requestedReferrer) {
    try {
      const parsedReferrer = new URL(requestedReferrer, location.href);
      if (parsedReferrer.origin === location.origin) referrer = parsedReferrer.toString();
    } catch {
      // Fetch will use the current document as its safe referrer.
    }
  }

  let body: BodyInit | undefined;
  if (request.bodyBase64 !== undefined) {
    const binary = atob(request.bodyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    body = bytes.buffer;
  } else if (request.form) {
    body = new URLSearchParams(request.form);
  } else if (request.multipart) {
    const formData = new FormData();
    for (const [name, value] of Object.entries(request.multipart)) formData.append(name, value);
    body = formData;
  }

  const response = await fetch(target, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(referrer ? { referrer } : {}),
    credentials: 'include',
    redirect: 'manual',
    signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
  });
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...responseBytes.subarray(offset, offset + chunkSize));
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    url: response.url || request.url,
    headers: responseHeaders,
    bodyBase64: btoa(binary),
    redirected: response.redirected || response.type === 'opaqueredirect' || response.status === 0,
  };
}

export async function runBrowserNativeRequest(
  page: Page,
  request: BrowserNativeRequest,
  crossOriginPolicy?: BrowserNativeCrossOriginPolicy,
): Promise<BrowserNativeResponse> {
  validateBrowserNativeRequest(request);
  const origins = validatedRequestOrigins(request, page.url(), crossOriginPolicy);
  const performRequest = (effectiveRequest: BrowserNativeRequest) => page.evaluate(
    browserNativeFetchInPage,
    { ...effectiveRequest, ...origins },
  );
  const response = request.cookiePolicy === 'http-only'
    ? await runWithHttpOnlyBrowserCookies(page, request, performRequest)
    : await performRequest(request);
  return {
    ...response,
    url: new URL(response.url, request.url).toString(),
  };
}

export function browserNativeResponseBody(response: BrowserNativeResponse): Buffer {
  return Buffer.from(response.bodyBase64, 'base64');
}

export function browserNativeResponseOk(response: BrowserNativeResponse): boolean {
  return response.status >= 200 && response.status < 300;
}
