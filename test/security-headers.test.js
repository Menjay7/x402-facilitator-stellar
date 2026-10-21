/**
 * Security headers (#86).
 *
 * Only the headers that do something for a JSON API are asserted: nosniff,
 * HSTS (production only) and the absence of X-Powered-By. CSP is deliberately
 * absent — no documents are served — see app.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './helpers/app.js';

describe('security headers', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('nosniff is set on responses', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('X-Powered-By is not sent', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('HSTS is not sent outside production', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('strict-transport-security'), null);
  });

  test('X-Frame-Options is set to DENY', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('Referrer-Policy is set to strict-origin-when-cross-origin', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });
});

describe('security headers: production', () => {
  test('HSTS is sent in production with preload', async () => {
    const app = await serve({ nodeEnv: 'production' });
    try {
      const res = await app.get('/healthz');
      const hsts = res.headers.get('strict-transport-security');
      assert.match(hsts, /max-age=63072000/);
      assert.match(hsts, /includeSubDomains/);
      assert.match(hsts, /preload/);
    } finally {
      await app.close();
    }
  });
});

describe('security headers: error responses', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('headers present on 400 response', async () => {
    const res = await app.post('/verify', {});
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  test('headers present on 401 response', async () => {
    const app = await serve({
      config: { apiKeys: ['admin:supersecret-0123456789abcdefghijklmnopqrstuvwxyz'] },
    });
    try {
      const res = await app.post('/verify', {});
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    } finally {
      await app.close();
    }
  });

  test('headers present on 500 response', async () => {
    const app = await serve({
      facilitator: {
        calls: [],
        getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
        verify: async () => {
          throw new Error('facilitator error');
        },
        settle: async () => ({ success: true, transaction: 'abc123', network: 'stellar:testnet' }),
      },
    });
    try {
      const res = await app.post('/verify', {
        paymentPayload: {
          x402Version: 2,
          scheme: 'exact',
          network: 'stellar:testnet',
          payload: { transaction: 'TX' },
        },
        paymentRequirements: {
          scheme: 'exact',
          network: 'stellar:testnet',
          asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          maxAmountRequired: '1000',
          payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
        },
      });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    } finally {
      await app.close();
    }
  });
});
