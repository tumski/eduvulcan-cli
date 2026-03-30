import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchJsonInPage } from '../src/fetch.js';

type FakePage = {
  evaluate: <TArg, TResult>(
    pageFunction: (arg: TArg) => Promise<TResult>,
    arg: TArg,
  ) => Promise<TResult>;
};

function makeFakePage(): FakePage {
  return {
    evaluate: async (pageFunction, arg) => pageFunction(arg),
  };
}

test('fetchJsonInPage returns parsed JSON from browser context fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ hello: 'world' }),
  })) as typeof fetch;

  try {
    const result = await fetchJsonInPage<{ hello: string }>(makeFakePage(), 'https://example.com/api', {
      Accept: 'application/json',
    });

    assert.deepEqual(result, {
      ok: true,
      status: 200,
      statusText: 'OK',
      data: { hello: 'world' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchJsonInPage reports non-ok responses without throwing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    json: async () => ({ message: 'denied' }),
  })) as typeof fetch;

  try {
    const result = await fetchJsonInPage(makeFakePage(), 'https://example.com/api', {});

    assert.deepEqual(result, {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchJsonInPage preserves thrown browser fetch errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchJsonInPage(makeFakePage(), 'https://example.com/api', {}),
      /fetch failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
