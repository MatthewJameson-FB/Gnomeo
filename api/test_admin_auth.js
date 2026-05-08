const assert = require('assert');
const { requireAdmin } = require('./_adminAuth');

const makeRes = () => {
  const result = { statusCode: null, body: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    },
  };
  return { res, result };
};

const run = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
};

run('missing ADMIN_SECRET returns 500', () => {
  const previous = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  const { res, result } = makeRes();
  const ok = requireAdmin({ headers: {} }, res);
  assert.strictEqual(ok, false);
  assert.strictEqual(result.statusCode, 500);
  assert.deepStrictEqual(result.body, { error: 'Admin access is not configured.' });
  if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
});

run('missing Authorization returns 401', () => {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'test-secret';
  const { res, result } = makeRes();
  const ok = requireAdmin({ headers: {} }, res);
  assert.strictEqual(ok, false);
  assert.strictEqual(result.statusCode, 401);
  assert.deepStrictEqual(result.body, { error: 'Unauthorized.' });
  if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
});

run('wrong token returns 401', () => {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'test-secret';
  const { res, result } = makeRes();
  const ok = requireAdmin({ headers: { authorization: 'Bearer nope' } }, res);
  assert.strictEqual(ok, false);
  assert.strictEqual(result.statusCode, 401);
  assert.deepStrictEqual(result.body, { error: 'Unauthorized.' });
  if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
});

run('correct token returns true without error response', () => {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'test-secret';
  const { res, result } = makeRes();
  const ok = requireAdmin({ headers: { authorization: 'Bearer test-secret' } }, res);
  assert.strictEqual(ok, true);
  assert.strictEqual(result.statusCode, null);
  assert.strictEqual(result.body, null);
  if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
});
