# route-contract

**Catch broken redirects and HTTP header regressions before calling a deployment done.**

A small, dependency-free Node.js CLI. Describe expected responses in JSON, then
run the same checks against localhost, staging or production. An unexpected
status, changed redirect destination or missing response header fails the run.

```text
PASS / (200)
PASS /old-page (301)
FAIL /missing-page (200)
  status: expected 404; got 200
2/3 routes matched
```

## Install

Requires **Node.js 22 or newer**. No npm registry release is available yet; install
from source:

```sh
git clone https://github.com/joshwebtimestwo/route-contract.git
cd route-contract
npm link
route-contract --help
```

You can also run `node bin/route-contract.mjs` directly. There are no runtime or
development dependencies to download.

## Write a contract

Create `routes.json`:

```json
{
  "version": 1,
  "routes": [
    { "path": "/", "status": 200 },
    { "path": "/old-page", "status": 301, "headers": { "location": "/new-page" } },
    { "path": "/search", "status": 200, "headers": { "x-robots-tag": { "includes": "noindex" } } },
    { "path": "/missing-page", "status": 404, "headers": { "cache-control": { "includes": "no-store" } } }
  ]
}
```

```sh
route-contract routes.json --base http://localhost:3000
route-contract routes.json --base https://example.com --timeout 5000 --json > report.json
```

The example paths describe an imaginary application. Change them to match your
own routes before running. `examples/routes.json` provides another starting point.

## Contract reference

| Field | Meaning |
| --- | --- |
| `version` | Required; currently `1` |
| `routes` | 1–200 route objects, checked sequentially |
| `path` | Root-relative URL; queries are allowed; fragments are rejected |
| `status` | Exact expected HTTP status, from 200 to 599 |
| `method` | Optional `GET` (default) or `HEAD`; useful for large assets and header-only checks |
| `headers` | Optional response-header assertions, with case-insensitive names |

Header expectations accept an exact string, `null` for an absent header, or
`{"includes":"text"}` for a case-sensitive substring. This is literal matching,
not a parser for cache directives or robot-specific indexing rules. `Location`
is compared exactly as sent by the server, without resolving relative URLs.
Repeated header values are observed as combined by the Fetch API.

The base must be an HTTP(S) origin, such as `https://example.com` or
`http://127.0.0.1:3000`. No credentials, path, query or fragment is permitted.
Unknown fields and malformed contracts fail before any network request occurs.

| Exit code | Meaning |
| --- | --- |
| `0` | Every assertion matched |
| `1` | At least one assertion or network request failed |
| `2` | Invalid arguments, unreadable file or invalid contract |

Timeouts apply to each route (default 10 seconds; permitted range 1–300,000 ms).
A network failure is recorded and the remaining routes continue. JSON output
includes overall and per-route results; failed assertions include expected and
actual values.

## Use from JavaScript

```js
import { audit } from './src/audit.mjs';

const report = await audit({
  version: 1,
  routes: [{ path: '/', status: 200 }]
}, { base: 'http://localhost:3000', timeout: 3000 });

console.log(report.passed);
```

## Development and CI

```sh
npm test
npm run check
npm pack --dry-run
```

Tests use local HTTP fixtures and injected responses, including CLI exit codes,
timeouts, validation, failed assertions and redirects that must not be followed.
CI runs the suite on Node.js 22 and 24 on Linux and Windows.

Use the CLI as a deployment step after starting your application:

```sh
node bin/route-contract.mjs routes.json --base http://localhost:3000
```

## Scope

- Requests use GET by default or an explicit HEAD, with manual redirects. Redirect
  destinations are never fetched. A server can return different headers for GET
  and HEAD; choose the method whose behaviour you need to test.
- Page bodies are cancelled rather than buffered or saved. Requests and reports
  still contain the configured paths and asserted header values: do not put secrets
  in a contract you intend to commit or publish.
- Only run contracts against services you are authorised to test. Requests can
  reach local/private addresses when explicitly chosen as the base.
- This tool does not execute JavaScript, inspect HTML meta tags, read robots.txt,
  prove search-engine indexing, or test an entire redirect chain. It tests the
  HTTP response contract you supplied.
- No browser, telemetry, paid service or credentials required.

## Contributing

Bug reports should include a minimal contract and a synthetic server response.
Please remove tokens, private URLs and response bodies. For code changes, add a
focused regression test and run `npm test` plus `npm run check`.

MIT licensed. Built by [mezy](https://mezy.gg).
