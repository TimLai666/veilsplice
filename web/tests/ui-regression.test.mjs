import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../app/console.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
test('results summary remains a full-width block before the table, without Tailwind table-caption collision', () => {
 assert.match(source, /<p className="results-summary">[^]*?<\/p><Table>/);
 assert.doesNotMatch(source, /className="table-caption"/);
 assert.match(css, /\.results-summary\{display:block;width:100%/);
});
test('enabled buttons have pointer affordance and refresh has visible hover and keyboard focus', () => {
 assert.match(css, /button:not\(:disabled\)\{cursor:pointer\}/);
 assert.match(css, /\.connection button:not\(:disabled\):hover\{background:/);
 assert.match(css, /\.connection button:focus-visible\{outline:/);
});
