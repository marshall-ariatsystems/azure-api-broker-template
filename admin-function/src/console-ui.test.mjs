import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/style.css', import.meta.url);
const scriptUrl = new URL('../public/app.js', import.meta.url);

test('console shell exposes accessible navigation and cache-busted assets', async () => {
  const [html, script] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(scriptUrl, 'utf8')]);

  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /id="menu-toggle"[^>]+aria-controls="primary-nav"/);
  assert.match(html, /id="nav-scrim"[^>]+aria-label="Close navigation"/);
  assert.match(html, /\/console\/style\.css\?v=[a-zA-Z0-9-]+/);
  assert.match(html, /\/console\/app\.js\?v=[a-zA-Z0-9-]+/);
  assert.match(script, /\.inert = closedOnMobile/);
  assert.match(script, /aria-current/);
});

test('console stylesheet preserves focus, motion, and responsive contracts', async () => {
  const css = await readFile(cssUrl, 'utf8');

  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /body\.nav-open \.sidebar/);
  assert.match(css, /min-height: 40px/);
});

test('traffic inspection exposes filtering, detail, and retention safeguards', async () => {
  const [html, script] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(scriptUrl, 'utf8')]);

  assert.match(html, /data-view="traffic"/);
  assert.match(html, /id="traffic-filter"/);
  assert.match(html, /id="traffic-status"/);
  assert.match(html, /id="traffic-hours"/);
  assert.match(html, /id="traffic-dialog"/);
  assert.match(html, /Injected credentials and authorization headers are never stored/);
  assert.match(script, /api\(`\/traffic\?hours=/);
  assert.match(script, /api\(`\/traffic\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(script, /Credential injection occurs after request validation and is never copied into this record/);
});

test('default console colors meet text and control contrast targets', () => {
  const contrast = (foreground, background) => {
    const luminance = (hex) => {
      const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  assert.ok(contrast('dde5ee', '0f1319') >= 4.5, 'primary text must meet WCAG AA');
  assert.ok(contrast('91a0b3', '171d26') >= 4.5, 'muted text must meet WCAG AA');
  assert.ok(contrast('061423', '4da3ff') >= 4.5, 'accent buttons must meet WCAG AA');
});
