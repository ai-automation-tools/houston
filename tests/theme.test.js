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
