import type { Page } from 'playwright';
import { runAuthenticatedHttpRequest } from '../authenticatedHttp.ts';

export const netBenefitsStatementUrl = 'https://retiretxn.fidelity.com/nbretail/savings2/navigation/dc/OnlineStatement';
const statementAction = '/nbretail/savings2/sod/soddetail';
function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    return named[entity.toLowerCase()] ?? String.fromCodePoint(Number.parseInt(entity.slice(entity[2]?.toLowerCase() === 'x' ? 3 : 2, -1), entity[2]?.toLowerCase() === 'x' ? 16 : 10));
  });
}

export interface NetBenefitsStatementForm {
  planId: string;
  action: string;
  fields: Record<string, string>;
  availableThrough: string;
}

export async function parseNetBenefitsStatementForm(html: string): Promise<NetBenefitsStatementForm> {
  const fields: Record<string, string> = {};
  let action = '';
  let forms = 0;
  await new HTMLRewriter()
    .on('form[name="frmRequest"]', { element(element) {
      forms += 1;
      action = element.getAttribute('action') ?? '';
      if (element.getAttribute('method')?.toLowerCase() !== 'post') throw new Error('NetBenefits statement form method is invalid');
    } })
    .on('form[name="frmRequest"] input[type="hidden"]', { element(element) {
      const name = element.getAttribute('name');
      if (!name || Object.hasOwn(fields, name)) throw new Error('NetBenefits statement form fields are ambiguous');
      fields[name] = decodeAttribute(element.getAttribute('value') ?? '');
    } }).transform(new Response(html)).text();
  const planIds = [...html.matchAll(/\bplanNumber\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map(match => match[1]!);
  const uniquePlans = [...new Set(planIds.filter(id => id !== 'noop'))];
  const through = fields.ytdDateRange?.match(/^\d{2}\/\d{2}\/\d{4}-(\d{2})\/(\d{2})\/(\d{4})$/);
  if (forms !== 1 || action !== statementAction || uniquePlans.length !== 1 || !fields.txntoken || !through
      || !['sodReqIndicator', 'dateRange', 'sodPreview', 'consentReq'].every(name => Object.hasOwn(fields, name))) {
    throw new Error('NetBenefits statement form metadata is missing or ambiguous');
  }
  const availableThrough = `${through[3]}-${through[1]}-${through[2]}`;
  if (!validDate(availableThrough)) throw new Error('NetBenefits available statement date is invalid');
  return { planId: uniquePlans[0]!, action, fields, availableThrough };
}

export function netBenefitsStatementPeriods(from: string, through: string): Array<{ from: string; through: string }> {
  if (!validDate(from) || !validDate(through) || from > through) throw new Error('NetBenefits statement date window is invalid');
  const periods: Array<{ from: string; through: string }> = [];
  let month = `${from.slice(0, 7)}-01`;
  while (month <= through) {
    const next = new Date(`${month}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
    periods.push({ from: month, through: end < through ? end : through });
    month = next.toISOString().slice(0, 10);
    if (periods.length > 121) throw new Error('NetBenefits statement window exceeds supported history');
  }
  return periods;
}

export async function fetchNetBenefitsStatements(
  page: Page,
  planIds: readonly string[],
  range: { from: string; through: string },
  receive: (statement: { planId: string; from: string; through: string; bytes: Buffer }) => Promise<void>,
  request: typeof runAuthenticatedHttpRequest = runAuthenticatedHttpRequest,
): Promise<void> {
  if (planIds.length === 0) return;
  const transport = { request: page.request, url: () => new URL(netBenefitsStatementUrl).origin };
  const loadForm = async () => {
    const response = await request(transport, { url: netBenefitsStatementUrl, timeoutMs: 30000 });
    if (response.status !== 200 || !response.headers['content-type']?.includes('text/html')) {
      throw new Error('NetBenefits statement discovery requires authentication');
    }
    return parseNetBenefitsStatementForm(response.body.toString('latin1'));
  };
  const initial = await loadForm();
  // Do not silently label retail-only downloads complete for an unvisited plan.
  // Account switching must come from verified institution metadata, never a nickname.
  if (planIds.length !== 1 || planIds[0] !== initial.planId) {
    throw new Error('NetBenefits statement account discovery did not cover every retirement plan');
  }
  const through = range.through < initial.availableThrough ? range.through : initial.availableThrough;
  if (range.from > through) throw new Error('NetBenefits has no statement coverage in the requested window');
  const date = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  for (const period of netBenefitsStatementPeriods(range.from, through)) {
    const form = await loadForm();
    if (form.planId !== initial.planId) throw new Error('NetBenefits statement account changed during download');
    const response = await request(transport, {
      url: new URL(form.action, netBenefitsStatementUrl).href, method: 'POST', timeoutMs: 60000,
      form: { ...form.fields, dateRange: `${date(period.from)}-${date(period.through)}` },
    });
    if (response.status !== 200 || !response.headers['content-type']?.includes('text/html')) {
      throw new Error('NetBenefits statement download did not return HTML');
    }
    await receive({ planId: form.planId, ...period, bytes: response.body });
  }
}
