/**
 * Verification for the classification guard: the seam where a model answer
 * becomes a work order.
 *
 * Why this exists: unknown -> 'pothole' fallbacks sat in TWO places (here and
 * lib/spark.ts), and that is exactly how an intact manhole cover came out of
 * the pipeline as a pothole work order: the prompt offered no way to refuse,
 * and any answer outside the five taxonomy keys was rewritten into one. Nine
 * live rows carried justifications reading "manhole cover" while typed
 * pothole. These assertions pin the reject path so it cannot quietly return.
 *
 * What it pins down:
 *   1. the five taxonomy keys pass through, tolerant of the case, padding and
 *      separator noise models actually emit
 *   2. a present-but-unknown answer - a manhole cover named plainly, or
 *      gibberish - is 'not_a_defect', never a fabricated pothole
 *   3. a missing type keeps the historical default
 *   4. the classification prompt offers 'not_a_defect' and names the covers
 *
 * Run: npm run verify
 */
import { normalizeType } from '../lib/meta';
import { buildClassificationPrompt } from '../lib/spark';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   - ${msg}`);
  }
}

/* ---------------- normalizeType ---------------- */

type Case = { name: string; input: unknown; want: string };

const TABLE: Case[] = [
  // The five keys pass through untouched...
  { name: 'pothole passes', input: 'pothole', want: 'pothole' },
  { name: 'cave_in passes', input: 'cave_in', want: 'cave_in' },
  { name: 'crack passes', input: 'crack', want: 'crack' },
  { name: 'blocked_lane passes', input: 'blocked_lane', want: 'blocked_lane' },
  { name: 'debris passes', input: 'debris', want: 'debris' },
  // ...in whatever shape the model emits them.
  { name: 'capitalised is tolerated', input: 'Pothole', want: 'pothole' },
  { name: 'padded is tolerated', input: '  CRACK  ', want: 'crack' },
  { name: 'hyphen separator is tolerated', input: 'blocked-lane', want: 'blocked_lane' },
  // The reject: this is the incident the module exists for.
  { name: 'a plainly named manhole cover is rejected', input: 'manhole cover', want: 'not_a_defect' },
  { name: 'the sentinel itself is preserved', input: 'not_a_defect', want: 'not_a_defect' },
  { name: 'any other out-of-taxonomy answer is rejected', input: 'big hole', want: 'not_a_defect' },
  { name: 'a non-string answer is rejected', input: 42, want: 'not_a_defect' },
  // Absence keeps the historical default; only presence-but-unknown rejects.
  { name: 'a missing type keeps the default', input: null, want: 'pothole' },
  { name: 'an undefined type keeps the default', input: undefined, want: 'pothole' },
];

for (const c of TABLE) {
  assert(normalizeType(c.input) === c.want, `${c.name} -> ${c.want}`);
}

/* ---------------- buildClassificationPrompt ---------------- */

const prompt = buildClassificationPrompt();
assert(prompt.includes('not_a_defect'), 'the prompt offers not_a_defect as an answer');
assert(/manhole/i.test(prompt), 'the prompt names manhole covers explicitly');
assert(
  prompt.includes('force one of these into the list above'),
  'the prompt forbids forcing a non-defect into the taxonomy'
);

console.log(process.exitCode ? '\nFAILED' : '\nAll classification assertions passed.');
