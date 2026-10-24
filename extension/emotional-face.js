/* emotional-face.js — fixed local SigLIP concepts for exaggerated thumbnail expressions.
 * Independent classifier layer; it does not import code or assets from DeArrow.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.YB = root.YB || {};
    root.YB.emotionalFace = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const PROMPTS = Object.freeze([
    'a YouTube thumbnail showing a person with an extremely exaggerated shocked facial expression, very wide eyes and mouth open',
    'a YouTube thumbnail showing a person with an exaggerated angry or furious facial expression',
    'a YouTube thumbnail showing a person with an exaggerated scared or horrified facial expression',
    'a YouTube thumbnail showing a person with an extremely exaggerated excited facial expression, raised eyebrows and mouth wide open',
    'a YouTube thumbnail showing a person with an exaggerated disgusted or astonished facial expression'
  ]);

  function bestMatch(scores, threshold) {
    const value = Number(threshold);
    const min = Number.isFinite(value) ? value : 0.45;
    let best = null;

    for (const item of scores || []) {
      if (!item || !PROMPTS.includes(item.text) || !Number.isFinite(item.score)) continue;
      if (!best || item.score > best.score) best = item;
    }

    return best && best.score >= min ? { text: best.text, score: best.score } : null;
  }

  return { PROMPTS, bestMatch };
});
