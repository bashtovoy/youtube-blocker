const assert = require('node:assert/strict');
const { PROMPTS, bestMatch } = require('../extension/emotional-face.js');

assert.ok(PROMPTS.length >= 4, 'several expression prompts are available');
assert.ok(PROMPTS.every(p => typeof p === 'string' && p.length > 20), 'prompts are descriptive');

const shock = PROMPTS[0];
const anger = PROMPTS[1];
assert.deepEqual(
  bestMatch([
    { text: 'an unrelated landscape', score: 0.99 },
    { text: shock, score: 0.71 },
    { text: anger, score: 0.62 }
  ], 0.45),
  { text: shock, score: 0.71 },
  'only known face prompts participate and the strongest qualifying score wins'
);
assert.equal(bestMatch([{ text: shock, score: 0.44 }], 0.45), null, 'scores below threshold are ignored');
assert.equal(bestMatch([{ text: shock, score: Number.NaN }], 0.3), null, 'non-finite scores are ignored');
assert.equal(bestMatch([{ text: shock, score: 0.8 }], 0.9), null, 'a stricter threshold prevents a match');

console.log('emotional-face tests passed');
