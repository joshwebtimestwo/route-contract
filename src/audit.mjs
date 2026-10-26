const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, label) => {
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}`);
  }
};

export function validateContract(contract) {
  keys(contract, ['version', 'routes'], 'contract');
  if (contract.version !== 1) throw new TypeError('contract.version must be 1');
  if (!Array.isArray(contract.routes) || contract.routes.length < 1 || contract.routes.length > 200) {
    throw new TypeError('contract.routes must contain between 1 and 200 routes');
  }
  for (const [index, route] of contract.routes.entries()) {
    const label = `routes[${index}]`;
    keys(route, ['path', 'status', 'headers'], label);
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.startsWith('//') || /[\\#\s\u0000-\u001f\u007f]/u.test(route.path)) {
      throw new TypeError(`${label}.path must be a root-relative URL without a fragment or whitespace`);
    }
    if (!Number.isInteger(route.status) || route.status < 200 || route.status > 599) {
      throw new TypeError(`${label}.status must be an integer from 200 to 599`);
    }
    if (route.headers !== undefined) {
      if (!object(route.headers)) throw new TypeError(`${label}.headers must be an object`);
      const names = new Set();
      for (const [name, expected] of Object.entries(route.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || names.has(name.toLowerCase())) {
          throw new TypeError(`${label} has an invalid or repeated header name`);
        }
        names.add(name.toLowerCase());
        if (typeof expected === 'string' || expected === null) continue;
        keys(expected, ['includes'], `${label}.headers.${name}`);
        if (typeof expected.includes !== 'string' || expected.includes.length === 0) {
          throw new TypeError(`${label} header includes must be a non-empty string`);
        }
      }
    }
  }
  return contract;
}

export function validateBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Base must be an HTTP(S) origin without credentials, a path, query or fragment');
  }
  return url.origin;
}

export async function audit(contract, { base, timeout = 10000, fetch: request = globalThis.fetch } = {}) {
  validateContract(contract);
  const origin = validateBase(base);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) {
    throw new TypeError('Timeout must be an integer from 1 to 300000 milliseconds');
  }
  // Validate every target before issuing any network requests.
  const targets = contract.routes.map(route => {
    const url = new URL(route.path, origin);
    if (url.origin !== origin) throw new TypeError('All routes must use the base origin');
    return url;
  });
  const results = [];
  for (const [index, route] of contract.routes.entries()) {
    const result = { path: route.path, status: null, passed: false, failures: [] };
    try {
      const response = await request(targets[index], {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': 'route-contract/0.1.0' },
      });
      result.status = response.status;
      if (response.status !== route.status) {
        result.failures.push({ check: 'status', expected: route.status, actual: response.status });
      }
      for (const [name, expected] of Object.entries(route.headers ?? {})) {
        const actual = response.headers.get(name);
        const matched = object(expected) ? actual !== null && actual.includes(expected.includes) : actual === expected;
        if (!matched) result.failures.push({ check: `header:${name.toLowerCase()}`, expected, actual });
      }
      // Never persist or buffer page bodies. Redirect targets are never followed.
      await response.body?.cancel();
      result.passed = result.failures.length === 0;
    } catch (error) {
      result.error = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request_failed';
    }
    results.push(result);
  }
  return { version: 1, base: origin, passed: results.every(result => result.passed), results };
}
