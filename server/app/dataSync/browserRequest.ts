import type { Page } from 'playwright';

export type BrowserNativeRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
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

function isBrowserOwnedRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return browserOwnedRequestHeaders.has(normalized) || normalized.startsWith('sec-fetch-');
}

export function safeBrowserRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isBrowserOwnedRequestHeader(name)));
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
    ].includes(name) || name.startsWith('sec-fetch-')) continue;
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
  const response = await page.evaluate(browserNativeFetchInPage, { ...request, ...origins });
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
