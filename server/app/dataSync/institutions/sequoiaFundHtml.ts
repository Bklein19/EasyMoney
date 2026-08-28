export type SequoiaFundStatementHtml = {
  csrfToken: string | null;
};

function decodedHtmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"',
  };
  return value.replaceAll(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (reference, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? reference;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const digits = entity.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return reference;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return reference;
    }
  });
}

function decodedAttribute(element: HTMLRewriterTypes.Element, name: string): string {
  return decodedHtmlText(element.getAttribute(name) ?? '').trim();
}

function uniqueValue(target: string[], value: string): void {
  if (value && !target.includes(value)) target.push(value);
}

export function parseSequoiaFundStatementHtml(html: string): SequoiaFundStatementHtml {
  const scriptTokens = [...html.matchAll(/\bactiveCSRFtoken\s*=\s*(['"])(.*?)\1/gi)]
    .map(match => decodedHtmlText(match[2] ?? '').trim())
    .filter(Boolean);
  const inputTokens: string[] = [];
  const metaTokens: string[] = [];

  const rewriter = new HTMLRewriter()
    .on('input[name="csrf_token"]', {
      element(element) {
        uniqueValue(inputTokens, decodedAttribute(element, 'value'));
      },
    })
    .on('meta[name="csrf-token"]', {
      element(element) {
        uniqueValue(metaTokens, decodedAttribute(element, 'content'));
      },
    });

  rewriter.transform(html);
  return {
    csrfToken: scriptTokens[0] ?? inputTokens[0] ?? metaTokens[0] ?? null,
  };
}
