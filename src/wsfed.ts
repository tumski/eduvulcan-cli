/**
 * WS-Federation form-post handoff for the EduVulcan student portal.
 *
 * The parent portal still sends the browser to
 * `https://uczen.eduvulcan.pl/<tenant>/Start?profil=...`. That route now
 * renders "Strona nie została odnaleziona", and a Chromium navigation that
 * stops there does not leave a usable API session (Context comes back 404).
 * The diary APIs answer once the WS-Fed `wresult` form chain is posted.
 *
 * Those forms embed a SAML token in a quoted attribute. The token contains
 * raw `>` characters. A scanner that treats every `>` as the end of the tag
 * (`<input[^>]*>`) truncates `wresult`, the federation POST is rejected, and
 * the browser lands on the dead Start page. Parsing has to be quote-aware.
 */

export interface WsFedForm {
  action: string;
  fields: Record<string, string>;
}

export interface HttpRequestInit {
  method: 'GET' | 'POST';
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface HttpResponseLike {
  url: string;
  status: number;
  headers: Record<string, string>;
  text: () => Promise<string>;
}

export interface HttpClient {
  request(url: string, init: HttpRequestInit): Promise<HttpResponseLike>;
}

export interface WsFedHop {
  url: string;
  status: number;
  method: 'GET' | 'POST';
}

export interface WsFedChainResult {
  finalUrl: string;
  status: number;
  hops: WsFedHop[];
  region: string | null;
  notFound: boolean;
}

const MAX_HOPS = 8;

const TENANT_SKIP = new Set([
  'api',
  'account',
  'app',
  'start',
  'fs',
  'content',
  'scripts',
  'errorpage.aspx',
]);

export function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|amp|lt|gt);/g, (entity) => {
    switch (entity.toLowerCase()) {
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      default: {
        const hex = entity.match(/^&#x([0-9a-fA-F]+);$/i);
        if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
        const dec = entity.match(/^&#(\d+);$/);
        if (dec) return String.fromCodePoint(parseInt(dec[1], 10));
        return entity;
      }
    }
  });
}

function fullyDecodeUri(input: string): string {
  let current = input;
  for (let i = 0; i < 4; i += 1) {
    try {
      const next = decodeURIComponent(current.replace(/\+/g, '%20'));
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

export function extractTenant(...inputs: Array<string | undefined>): string | null {
  const pattern = /(?:uczen\.eduvulcan\.pl|wiadomosci\.eduvulcan\.pl|dziennik-logowanie\.vulcan\.net\.pl)\/([A-Za-z0-9_-]+)/gi;
  for (const input of inputs) {
    if (!input) continue;
    const decoded = fullyDecodeUri(input);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(decoded))) {
      const segment = match[1];
      if (!TENANT_SKIP.has(segment.toLowerCase())) {
        return segment;
      }
    }
  }
  return null;
}

interface ElementSpan {
  name: 'form' | 'input' | 'form-end';
  raw: string;
}

function scanTags(html: string): ElementSpan[] {
  const spans: ElementSpan[] = [];
  const lower = html.toLowerCase();
  let index = 0;

  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    const head = lower.slice(start, start + 8);
    let name: ElementSpan['name'] | null = null;
    if (head.startsWith('<form')) name = 'form';
    else if (head.startsWith('<input')) name = 'input';
    else if (head.startsWith('</form')) name = 'form-end';

    if (!name) {
      index = start + 1;
      continue;
    }

    let quote: '"' | "'" | null = null;
    let end = start + 1;
    for (; end < html.length; end += 1) {
      const ch = html[end];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '>') {
        end += 1;
        break;
      }
    }

    spans.push({ name, raw: html.slice(start, end) });
    index = end;
  }

  return spans;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=\/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  let skippedName = false;
  while ((match = pattern.exec(tag))) {
    if (!skippedName) {
      skippedName = true;
      continue;
    }
    const attrName = match[1].toLowerCase();
    if (match[2] === undefined && match[3] === undefined && match[4] === undefined) continue;
    attrs[attrName] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

export function parseWsFedForm(html: string): WsFedForm | null {
  let inForm = false;
  let action = '';
  let fields: Record<string, string> = {};
  let found: WsFedForm | null = null;

  for (const span of scanTags(html)) {
    if (span.name === 'form') {
      inForm = true;
      action = parseAttributes(span.raw).action ?? '';
      fields = {};
      continue;
    }

    if (span.name === 'form-end') {
      if (inForm && hasWresult(fields)) {
        found = { action, fields: { ...fields } };
      }
      inForm = false;
      fields = {};
      continue;
    }

    if (!inForm) continue;
    const attrs = parseAttributes(span.raw);
    if (!attrs.name) continue;
    const type = (attrs.type ?? '').toLowerCase();
    if (type && type !== 'hidden' && type !== 'submit') continue;
    fields[attrs.name] = attrs.value ?? '';
  }

  if (inForm && hasWresult(fields)) {
    found = { action, fields: { ...fields } };
  }

  return found;
}

function hasWresult(fields: Record<string, string>): boolean {
  return Object.keys(fields).some((name) => name.toLowerCase() === 'wresult' && fields[name].length > 0);
}

export function resolveAction(baseUrl: string, action: string): string {
  try {
    return new URL(action || baseUrl, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function looksNotFound(status: number, body: string): boolean {
  if (status === 404) return true;
  return /Strona nie została odnaleziona|Nie odnaleziono zasobu|nie została odnaleziona/i.test(body);
}

export function isJournalHandoffUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'uczen.eduvulcan.pl') {
    const segment = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    return Boolean(segment) && !TENANT_SKIP.has(segment);
  }
  if (url.hostname === 'eduvulcan.pl' && /^\/dziennik\/?$/.test(url.pathname)) return true;
  return false;
}

export function orderJournalHandoffs(hrefs: string[]): string[] {
  const unique = [...new Set(hrefs.filter(isJournalHandoffUrl))];
  return unique.sort((left, right) => {
    const leftRank = left.includes('/dziennik') ? 0 : 1;
    const rightRank = right.includes('/dziennik') ? 0 : 1;
    return leftRank - rightRank;
  });
}

export async function completeWsFedChain(client: HttpClient, startUrl: string): Promise<WsFedChainResult> {
  let url = startUrl;
  let method: 'GET' | 'POST' = 'GET';
  let form: Record<string, string> | undefined;
  const hops: WsFedHop[] = [];
  let region = extractTenant(startUrl);
  let finalUrl = startUrl;
  let status = 0;
  let notFound = false;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const response = await client.request(url, {
      method,
      form,
      headers: method === 'GET' ? { Accept: 'text/html,application/xhtml+xml' } : undefined,
    });
    const body = await response.text();
    finalUrl = response.url || url;
    status = response.status;
    region = extractTenant(finalUrl, url, body) ?? region;
    notFound = looksNotFound(status, body);
    hops.push({ url: finalUrl, status, method });

    const parsed = parseWsFedForm(body);
    if (!parsed) {
      return { finalUrl, status, hops, region, notFound };
    }

    const action = resolveAction(finalUrl, parsed.action);
    region = extractTenant(action, parsed.action) ?? region;
    url = action;
    method = 'POST';
    form = parsed.fields;
  }

  throw new Error(`WS-Fed handoff exceeded ${MAX_HOPS} hops starting at ${startUrl}`);
}
