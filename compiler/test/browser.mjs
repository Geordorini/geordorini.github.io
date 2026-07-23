// browser.mjs — smoke-test the playground in a real (headless) browser.
// Serves the compiler dir, loads the playground, waits for auto-compile of the
// default example, then drives a function call and checks the printed result.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
// Playwright is a dev-only convenience; skip cleanly if it isn't installed.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright not installed — skipping browser smoke test');
  process.exit(0);
}
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM || undefined;

const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let p = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8137, r));

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
// Ignore environmental noise: the missing favicon and the connection reset
// that happens when we tear the server down at the end of the test.
const ignore = (t) => /favicon|ERR_CONNECTION_RESET|404 \(Not Found\)/.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => { if (!ignore(String(e))) errors.push(String(e)); });

let ok = true;
try {
  await page.goto('http://localhost:8137/playground/index.html', { waitUntil: 'networkidle' });
  // auto-compile of fib should mark status ok
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('bytes wasm'), { timeout: 5000 });
  const status = await page.textContent('#status');
  console.log('status:', status.trim());

  // WAT should be present
  const wat = await page.textContent('#wat');
  if (!wat.includes('(module')) throw new Error('WAT missing');

  // drive a call: fib(10) => 55
  await page.fill('#args input', '10');
  await page.click('#runbar button');
  await page.waitForFunction(() => document.getElementById('result').textContent.includes('→'), { timeout: 3000 });
  const result = await page.textContent('#result');
  console.log('result:', result.trim());
  if (!result.includes('55')) throw new Error(`expected fib(10)=55, got: ${result}`);

  // trigger a type error via the editor and confirm diagnostics
  await page.evaluate(() => {
    document.getElementById('source').value = 'fn f(): int { return 1 + true; }';
    document.getElementById('run').click();
  });
  await page.waitForFunction(() => document.getElementById('status').className.includes('diag-err'), { timeout: 3000 });
  const diag = await page.textContent('#diag');
  console.log('diagnostic:', diag.split('\n')[0].trim());
  if (!diag.includes('numeric operands')) throw new Error('type error not reported');
} catch (err) {
  ok = false;
  console.error('BROWSER TEST FAILED:', err.message);
}

if (errors.length) { ok = false; console.error('console errors:', errors); }
await browser.close();
server.close();
console.log(ok ? '\n✓ browser playground works' : '\n✗ browser playground failed');
process.exit(ok ? 0 : 1);
