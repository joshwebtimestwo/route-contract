#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { audit } from '../src/audit.mjs';

const help = `Usage: route-contract <contract.json> --base <http(s)://origin> [--timeout <ms>] [--json]

Check HTTP status codes, redirect locations and response headers.
Redirects are inspected without following them. No page bodies are stored.

Options:
  --base       Target origin, such as https://example.com or http://localhost:3000
  --timeout    Per-route timeout in milliseconds (default 10000, maximum 300000)
  --json       Write a machine-readable report
  --help       Show this help

Exit codes: 0 all matched, 1 route/request failure, 2 invalid input.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(help);
  } else {
    let file;
    const options = {};
    let json = false;
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--')) {
        if (!['--base', '--timeout', '--json'].includes(arg) || seen.has(arg)) throw new Error(`Unknown or repeated option: ${arg}`);
        seen.add(arg);
        if (arg === '--json') { json = true; continue; }
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (arg === '--base') options.base = value;
        else options.timeout = /^\d+$/.test(value) ? Number(value) : NaN;
      } else {
        if (file) throw new Error('Supply exactly one contract file');
        file = arg;
      }
    }
    if (!file || !options.base) throw new Error('A contract file and --base are required; use --help for usage');
    const report = await audit(JSON.parse(await readFile(file, 'utf8')), options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const result of report.results) {
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.path} (${result.status ?? result.error})`);
        for (const failure of result.failures) console.log(`  ${failure.check}: expected ${JSON.stringify(failure.expected)}; got ${JSON.stringify(failure.actual)}`);
      }
      console.log(`${report.results.filter(result => result.passed).length}/${report.results.length} routes matched`);
    }
    process.exitCode = report.passed ? 0 : 1;
  }
} catch (error) {
  console.error(`route-contract: ${error.message}`);
  process.exitCode = 2;
}
