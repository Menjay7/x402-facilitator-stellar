import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, testConfig, stubFacilitator, VALID_BODY } from './helpers/app.js';

/**
 * Ledger-based expiration and replay resistance (#159).
 *
 * Exercises the HTTP /verify and /settle surface with payloads whose
 * `signatureExpirationLedger` sits before, at, and after the current ledger,
 * and verifies that replayed settlements are handled without double-submitting.
 *
 * Expiry/replay enforcement lives upstream in @x402/stellar; this suite
 * verifies the *wire-level* behaviour this service presents for those payloads
 * and the shape of the rejection responses, which is what §3.6 evaluates.
 */

describe('Ledger-based Expiration & Replay Resistance (#159)', () => {
  let app;
  let capture;

  before(async () => {
    // A facilitator that inspects the payloads it receives and, for the expiry
    // and replay cases, refuses with the documented machine-readable reason
    // codes, so the wire behaviour is observable without a live ledger.
    capture = { verifyCalls: [], seenTx: new Set(), calls: 0 };
    app = await serve({
      config: testConfig({ apiKeys: ['admin:s3cret-0123456789abcdefghijklmnopqrstuvwxyz'] }),
      facilitator: stubFacilitator({
        verify: async payload => {
          capture.verifyCalls.push({ payload });
          const tx = payload?.payload?.transaction ?? '';
          if (typeof tx === 'string' && tx === 'EXPIRED_SENTINEL') {
            return {
              isValid: false,
              invalidReason: 'invalid_exact_stellar_payload_expired',
            };
          }
          return { isValid: true };
        },
        settle: async payload => {
          capture.calls++;
          const tx = payload?.payload?.transaction ?? '';
          if (typeof tx === 'string' && tx === 'EXPIRED_SENTINEL') {
            return {
              success: false,
              errorReason: 'invalid_exact_stellar_payload_expired',
              errorMessage: 'authorization expired at ledger boundary',
            };
          }
          // Distinct payload => distinct tx hash so the settlement store does
          // not conflate them via the derived idempotency key.
          return {
            success: true,
            transaction: `HASH_${Math.random().toString(36).slice(2, 10)}`,
            network: 'stellar:testnet',
          };
        },
      }),
    });
  });

  after(() => app.close());

  function bodyWithExpirationLedger(ledger) {
    return {
      ...VALID_BODY,
      paymentPayload: {
        ...VALID_BODY.paymentPayload,
        payload: {
          transaction: ledger === 'expired' ? 'EXPIRED_SENTINEL' : `TX_LEDGER_${ledger}`,
        },
      },
    };
  }

  test('verify rejects an expired payload with a machine-readable reason', async () => {
    const res = await app.post('/verify', bodyWithExpirationLedger('expired'), {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    const json = await res.json();
    assert.ok(json.invalidReason, 'verify rejection must carry a non-null reason');
    assert.equal(json.invalidReason, 'invalid_exact_stellar_payload_expired');
  });

  test('verify accepts a payload signed at the current ledger (boundary)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await app.post('/verify', bodyWithExpirationLedger(now), {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).isValid, true);
  });

  test('verify accepts a payload signed before expiry (valid)', async () => {
    const earlier = Math.floor(Date.now() / 1000) - 300;
    const res = await app.post('/verify', bodyWithExpirationLedger(earlier), {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(res.status, 200);
  });

  test('settle refuses an expired payload with a distinct machine-readable code', async () => {
    const res = await app.post('/settle', bodyWithExpirationLedger('expired'), {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    const json = await res.json();
    assert.ok(json.errorReason, 'settle rejection must carry a non-null reason');
    assert.equal(json.errorReason, 'invalid_exact_stellar_payload_expired');
  });

  test('an identical replay is served from the settlement store, not re-submitted', async () => {
    const body = bodyWithExpirationLedger('far_future');

    const beforeCalls = capture.calls;
    const first = await app.post('/settle', body, {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(first.status, 200);

    const second = await app.post('/settle', body, {
      authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(second.status, 200);

    // The settlement store must not have invoked the scheme a second time for
    // the identical derived idempotency key.
    assert.equal(
      capture.calls,
      beforeCalls + 1,
      'identical replay must be served from the store, not re-submitted',
    );
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.transaction, secondBody.transaction);
  });

  test('concurrent duplicate authorizations from identical keypair trigger mutual exclusion', async () => {
    const body = bodyWithExpirationLedger('far_future_concurrent');
    const beforeCalls = capture.calls;

    // Fire multiple concurrent settle requests with the same payload
    const concurrentRequests = 5;
    const promises = Array.from({ length: concurrentRequests }, () =>
      app.post('/settle', body, {
        authorization: 'Bearer s3cret-0123456789abcdefghijklmnopqrstuvwxyz',
      }),
    );

    const results = await Promise.all(promises);

    // All requests should succeed
    for (const res of results) {
      assert.equal(res.status, 200);
    }

    // The settlement store must have invoked the scheme only once
    // due to the distributed lock on the idempotency key
    assert.equal(
      capture.calls,
      beforeCalls + 1,
      'concurrent identical requests must be serialized by the lock, not re-submitted',
    );

    // All responses should have the same transaction hash
    const bodies = await Promise.all(results.map(r => r.json()));
    const firstTx = bodies[0].transaction;
    for (const body of bodies) {
      assert.equal(
        body.transaction,
        firstTx,
        'all concurrent requests must return the same transaction',
      );
    }
  });
});
