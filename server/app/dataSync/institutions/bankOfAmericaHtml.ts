/** Parse server HTML without executing scripts or constructing a rendered page. */
function decode(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? original;
    const point = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
  });
}

type HtmlChoice = { label: string; value: string };

function choices(html: string, selector: string, attribute: string): HtmlChoice[] {
  const result: HtmlChoice[] = [];
  let current: HtmlChoice | undefined;
  new HTMLRewriter().on(selector, {
    element(element) {
      current = { label: '', value: decode(element.getAttribute(attribute) ?? '') };
      result.push(current);
    },
    text(chunk) {
      if (current) current.label += chunk.text;
    },
  }).transform(html);
  return result.map(item => ({ ...item, label: decode(item.label).replace(/\s+/g, ' ').trim() }));
}

export function parseBankOfAmericaAccountLinks(html: string, baseUrl: string): Array<{ label: string; destination: string }> {
  return choices(html, 'a[href*="/myaccounts/brain/redirect.go"]', 'href')
    .map(item => ({ label: item.label, destination: new URL(item.value, baseUrl).toString() }));
}

export function parseBankOfAmericaCardMetadata(html: string): {
  periods: HtmlChoice[];
  excelFileTypeValue: string;
} {
  const periods = choices(html, '#select_transaction option', 'value');
  const formats = choices(html, '#select_filetype option', 'value');
  const excel = formats.filter(option => /Microsoft Excel Format/i.test(option.label));
  if (excel.length !== 1 || !excel[0]!.value) throw new Error('Bank of America Excel download format was not found unambiguously');
  if (!periods.length) throw new Error('Bank of America activity response omitted its periods');
  return { periods, excelFileTypeValue: excel[0]!.value };
}
