import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completeWsFedChain,
  extractTenant,
  isJournalHandoffUrl,
  orderJournalHandoffs,
  parseWsFedForm,
  type HttpClient,
  type HttpResponseLike,
} from '../src/wsfed.js';

const TOKEN_WITH_RAW_GT = [
  '<t:RequestSecurityTokenResponse xmlns:t="urn:test">',
  '<t:RequestedSecurityToken>abc>def</t:RequestedSecurityToken>',
  '</t:RequestSecurityTokenResponse>',
].join('');

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Same shape Vulcan returns: quotes and `<` are escaped, but a raw `>` is
 * left inside the quoted value. A `<input[^>]*>` scan stops at that `>`.
 */
function formWithRawGreaterThan(): string {
  const escaped = htmlEscape(TOKEN_WITH_RAW_GT).replace('abc&gt;def', 'abc>def');
  return [
    '<html><body>',
    '<form method="post" action="https://dziennik-logowanie.vulcan.net.pl/zyrardow/Fs/Ls?wa=wsignin1.0&amp;wtrealm=https%3A%2F%2Fuczen.eduvulcan.pl%2Fzyrardow%2FAccount%2FLogin%3FreturnUrl%3Dhttps%253A%252F%252Fuczen.eduvulcan.pl%252Fzyrardow%252FStart%253Fprofil%253Dabc">',
    '<input type="hidden" name="wa" value="wsignin1.0" />',
    `<input type="hidden" name="wresult" value="${escaped}" />`,
    '<input type="hidden" name="wctx" value="auth=studentEV&amp;nslo=1" />',
    '<noscript><input type="submit" value="Submit" /></noscript>',
    '</form>',
    '<script>document.forms[0].submit()</script>',
    '</body></html>',
  ].join('');
}

function naiveInputTags(html: string): string[] {
  return html.match(/<input[^>]*>/gi) ?? [];
}

test('quote-aware parser keeps raw > inside wresult that a tag scan truncates', () => {
  const html = formWithRawGreaterThan();
  const naive = naiveInputTags(html).find((tag) => tag.includes('wresult'));
  assert.ok(naive);
  assert.equal(naive?.includes('abc>def'), false);
  assert.match(naive ?? '', /abc>$/);

  const form = parseWsFedForm(html);
  assert.ok(form);
  assert.equal(form?.fields.wresult, TOKEN_WITH_RAW_GT);
  assert.equal(form?.fields.wa, 'wsignin1.0');
  assert.equal(form?.fields.wctx, 'auth=studentEV&nslo=1');
  assert.match(form?.action ?? '', /uczen\.eduvulcan\.pl%252Fzyrardow%252FStart/);
});

test('parser accepts value before name and single-quoted attributes', () => {
  const html = [
    "<form action='/zyrardow/Account/Login'>",
    `<input type="hidden" value='${htmlEscape(TOKEN_WITH_RAW_GT).replace('abc&gt;def', 'abc>def')}' name='wresult' />`,
    '<input type="hidden" name="wa" value="wsignin1.0">',
    '</form>',
  ].join('');

  const form = parseWsFedForm(html);
  assert.equal(form?.action, '/zyrardow/Account/Login');
  assert.equal(form?.fields.wresult, TOKEN_WITH_RAW_GT);
  assert.equal(form?.fields.wa, 'wsignin1.0');
});

test('parser ignores pages that are not a WS-Fed form post', () => {
  const html = '<html><title>Błąd</title><p>Strona nie została odnaleziona</p></html>';
  assert.equal(parseWsFedForm(html), null);
});

test('tenant extraction survives the nested returnUrl encoding', () => {
  const action = 'https://dziennik-logowanie.vulcan.net.pl/zyrardow/Fs/Ls?wa=wsignin1.0&wtrealm=https%3A%2F%2Fuczen.eduvulcan.pl%2Fzyrardow%2FAccount%2FLogin%3FreturnUrl%3Dhttps%253A%252F%252Fuczen.eduvulcan.pl%252Fzyrardow%252FStart%253Fprofil%253Dabc';
  assert.equal(extractTenant(action), 'zyrardow');
  assert.equal(extractTenant('https://uczen.eduvulcan.pl/api/Context'), null);
  assert.equal(extractTenant('https://uczen.eduvulcan.pl/Start'), null);
});

test('journal handoff filter prefers /dziennik links and drops the marketing site', () => {
  const ordered = orderJournalHandoffs([
    'https://eduvulcan.pl/uczen/',
    'https://uczen.eduvulcan.pl/zyrardow/Start?profil=abc',
    'https://eduvulcan.pl/dziennik?id=1',
    'https://eduvulcan.pl/dziennik?id=1',
    'https://wiadomosci.eduvulcan.pl/zyrardow/App',
    'not a url',
  ]);

  assert.deepEqual(ordered, [
    'https://eduvulcan.pl/dziennik?id=1',
    'https://uczen.eduvulcan.pl/zyrardow/Start?profil=abc',
  ]);
  assert.equal(isJournalHandoffUrl('https://uczen.eduvulcan.pl/'), false);
});

test('request chain posts the full wresult and stops when Start?profil is not found', async () => {
  const html = formWithRawGreaterThan();
  const calls: Array<{ url: string; method: string; wresult?: string }> = [];

  const client: HttpClient = {
    async request(url, init): Promise<HttpResponseLike> {
      calls.push({ url, method: init.method, wresult: init.form?.wresult });
      if (init.method === 'GET') {
        return {
          url: 'https://eduvulcan.pl/fs/ls?wa=wsignin1.0',
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: async () => html,
        };
      }

      return {
        url: 'https://uczen.eduvulcan.pl/zyrardow/Start?profil=abc',
        status: 404,
        headers: { 'content-type': 'text/html' },
        text: async () => '<html><title>Błąd</title>Strona nie została odnaleziona</html>',
      };
    },
  };

  const result = await completeWsFedChain(client, 'https://eduvulcan.pl/dziennik?id=1');

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.wresult, TOKEN_WITH_RAW_GT);
  assert.match(calls[1]?.url ?? '', /dziennik-logowanie\.vulcan\.net\.pl\/zyrardow\/Fs\/Ls/);
  assert.equal(result.region, 'zyrardow');
  assert.equal(result.notFound, true);
  assert.equal(result.status, 404);
  assert.equal(result.finalUrl, 'https://uczen.eduvulcan.pl/zyrardow/Start?profil=abc');
});

test('nested federation posts each wresult before giving up', async () => {
  const first = formWithRawGreaterThan();
  const secondToken = '<t:RequestSecurityTokenResponse>second>token</t:RequestSecurityTokenResponse>';
  const secondEscaped = htmlEscape(secondToken).replace('second&gt;token', 'second>token');
  const second = [
    '<form method="post" action="https://uczen.eduvulcan.pl/zyrardow/Account/Login?returnUrl=https%3A%2F%2Fuczen.eduvulcan.pl%2Fzyrardow%2FApp">',
    `<input type="hidden" name="wresult" value="${secondEscaped}" />`,
    '<input type="hidden" name="wa" value="wsignin1.0" />',
    '</form>',
  ].join('');

  const posted: string[] = [];
  let step = 0;
  const client: HttpClient = {
    async request(url, init): Promise<HttpResponseLike> {
      step += 1;
      if (init.form?.wresult) posted.push(init.form.wresult);
      const bodies = [first, second, '<html>ok</html>'];
      const urls = [
        'https://eduvulcan.pl/fs/ls',
        'https://dziennik-logowanie.vulcan.net.pl/zyrardow/Fs/Ls',
        'https://uczen.eduvulcan.pl/zyrardow/App',
      ];
      return {
        url: urls[step - 1] ?? url,
        status: 200,
        headers: {},
        text: async () => bodies[step - 1] ?? '',
      };
    },
  };

  const result = await completeWsFedChain(client, 'https://eduvulcan.pl/dziennik?id=7');
  assert.deepEqual(posted, [TOKEN_WITH_RAW_GT, secondToken]);
  assert.equal(result.notFound, false);
  assert.equal(result.finalUrl, 'https://uczen.eduvulcan.pl/zyrardow/App');
  assert.equal(result.hops.length, 3);
});
