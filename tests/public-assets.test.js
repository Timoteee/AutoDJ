import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { publicAssets } = require('../lib/public-assets');
it('does not serve private state, source, dependencies or traversal paths', () => {
  for (const url of ['/config.json', '/queue.json', '/server.js', '/package.json', '/node_modules/express/index.js', '/css/../config.json']) {
    let passed = false;
    publicAssets(process.cwd())({ method: 'GET', path: url }, { sendFile() { throw new Error('Private file exposed'); } }, () => { passed = true; });
    expect(passed).toBe(true);
  }
});
it('serves local UI assets and resolves legacy icon URLs', () => {
  for (const url of ['/css/console.css', '/ui-resilience.js', '/icons/icon-192.png', '/sw.js']) {
    let sent;
    publicAssets(process.cwd())({ method: 'GET', path: url }, { set() {}, sendFile(file) { sent = file; } }, () => {});
    expect(fs.existsSync(sent)).toBe(true);
    expect(sent.startsWith(process.cwd())).toBe(true);
  }
});
it('console has no runtime Tailwind dependency and intrinsically sizes its logo', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'dj.html'), 'utf8');
  expect(html).not.toContain('cdn.tailwindcss.com');
  expect(html).not.toContain('tailwind.config');
  expect(html).toContain('href="/css/console.css"');
  expect(html).toMatch(/class="brand-mark" width="24" height="24"/);
});
