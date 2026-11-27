import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

/** The `--name: #color` variables in the first `:root { … }` after `from`. @param {number} from */
function colorVars(from) {
  const start = css.indexOf(':root {', from);
  const body = css.slice(start, css.indexOf('}', start));
  return new Set([...body.matchAll(/(--[\w-]+):\s*#/g)].map((m) => m[1]));
}

test('the light theme gives every shell color variable a light value', () => {
  const light = css.indexOf('@media (prefers-color-scheme: light)');
  assert.ok(light > 0, 'styles.css has a light block');
  const dark = colorVars(0);
  assert.ok(dark.size >= 10);
  assert.deepEqual([...dark].filter((v) => !colorVars(light).has(v)), []);
  assert.match(css.slice(light), /color-scheme:\s*light/);
});

/** `--name: #rrggbb` values in the first `:root { … }` after `from`. @param {number} from */
function colorValues(from) {
  const start = css.indexOf(':root {', from);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
}

/** WCAG 2 contrast ratio of two #rrggbb colors. @param {string} a @param {string} b */
function contrast(a, b) {
  const lum = (/** @type {string} */ hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('secondary and hint text reach WCAG AA (4.5:1) on every shell background, in both themes', () => {
  for (const [theme, from] of [['dark', 0], ['light', css.indexOf('@media (prefers-color-scheme: light)')]]) {
    const v = colorValues(/** @type {number} */ (from));
    for (const fg of ['--text', '--text-2', '--text-3']) {
      for (const bg of ['--bg', '--panel', '--panel-2']) {
        const ratio = contrast(v[fg], v[bg]);
        assert.ok(ratio >= 4.5, `${theme}: ${fg} ${v[fg]} on ${bg} ${v[bg]} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});
