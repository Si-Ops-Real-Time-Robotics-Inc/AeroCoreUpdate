import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Every text colour the admin UI ships must clear WCAG AA — 4.5:1 — against both surfaces it
 * can land on, in both colour schemes.
 *
 * This is a regression test for something that was wrong for a long time without anyone
 * noticing: `--ok`, `--warn`, `--err` and `--accent` were defined once, for the dark scheme,
 * and the light override never redefined them. In light mode the green "live on stable" tag
 * measured 2.1:1 and the amber one 2.0:1 — legible enough to look fine in a screenshot and
 * not legible enough to read on a laptop by a window. Eyes do not catch this; arithmetic does.
 */

const css = await readFile(new URL('../public/admin/styles.css', import.meta.url), 'utf8');

/** sRGB relative luminance, per WCAG 2.x. */
function luminance(hex) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = hex.replace('#', '');
  return 0.2126 * channel(parseInt(n.slice(0, 2), 16))
    + 0.7152 * channel(parseInt(n.slice(2, 4), 16))
    + 0.0722 * channel(parseInt(n.slice(4, 6), 16));
}

/** What `color-mix(in srgb, <colour> N%, transparent)` resolves to over a known surface. */
function mix(colour, surface, fraction) {
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.replace('#', '').slice(i - 1, i + 1), 16));
  const [f, b] = [channels(colour), channels(surface)];
  const blended = f.map((value, i) => Math.round(value * fraction + b[i] * (1 - fraction)));
  return `#${blended.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The custom properties declared inside one block. */
function tokensIn(source) {
  return Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)]
    .map((m) => [m[1], m[2]]));
}

const dark = tokensIn(/:root\s*\{([\s\S]*?)\n\}/.exec(css)[1]);
const light = {
  ...dark,
  ...tokensIn(/prefers-color-scheme: light\)[\s\S]*?:root\s*\{([\s\S]*?)\n {2}\}/.exec(css)[1]),
};

const SCHEMES = { dark, light };
/** Colours used for text. Not `border`, which is a boundary and answers to 3:1. */
const INK = ['text', 'muted', 'accent', 'ok', 'warn', 'err'];

describe('admin UI colour contrast', () => {
  for (const [scheme, tokens] of Object.entries(SCHEMES)) {
    for (const ink of INK) {
      for (const surface of ['bg', 'card']) {
        test(`${scheme}: --${ink} on --${surface} is readable`, () => {
          const ratio = contrast(tokens[ink], tokens[surface]);
          assert.ok(ratio >= 4.5,
            `--${ink} (${tokens[ink]}) on --${surface} (${tokens[surface]}) is `
            + `${ratio.toFixed(2)}:1, below the 4.5:1 minimum`);
        });
      }
    }

    // The filled button. Dark mode cannot use white here — white on that blue is 3.2:1 —
    // which is why --on-accent exists per scheme rather than being hardcoded.
    test(`${scheme}: button label on --accent is readable`, () => {
      const ratio = contrast(tokens['on-accent'], tokens.accent);
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1 is below 4.5:1`);
    });
  }

  /**
   * A chip's text sits on a tint of its own colour, not on the panel behind it — and the tint
   * eats margin the panel checks never see. At 16% the light-mode green chip measured 4.33:1
   * while every plain-surface check still passed, which is exactly the kind of failure that
   * survives a screenshot review.
   *
   * The percentage is read out of the stylesheet rather than hardcoded here, so raising the
   * tint later fails this test instead of quietly dimming a status.
   */
  for (const [scheme, tokens] of Object.entries(SCHEMES)) {
    for (const ink of ['ok', 'warn', 'muted']) {
      test(`${scheme}: the --${ink} chip is readable on its own tint`, () => {
        const declared = new RegExp(`--${ink}\\)\\s+(\\d+)%,\\s*transparent`).exec(css);
        assert.ok(declared, `no tint found for --${ink}`);
        const pct = Number(declared[1]) / 100;

        for (const surface of ['bg', 'card']) {
          const tinted = mix(tokens[ink], tokens[surface], pct);
          const ratio = contrast(tokens[ink], tinted);
          assert.ok(ratio >= 4.5,
            `--${ink} on its own ${declared[1]}% tint over --${surface} is `
            + `${ratio.toFixed(2)}:1, below 4.5:1`);
        }
      });
    }
  }

  test('both schemes define every colour they use', () => {
    for (const [scheme, tokens] of Object.entries(SCHEMES)) {
      for (const name of [...INK, 'on-accent', 'bg', 'card', 'border']) {
        assert.ok(tokens[name], `${scheme} scheme has no --${name}`);
      }
    }
  });
});

describe('admin UI stylesheet invariants', () => {
  /**
   * `hidden` has to beat any class that sets `display`.
   *
   * The browser's own `[hidden] { display: none }` is specificity (0,1,0) and loses to
   * `.login form { display: grid }` at (0,1,1). The symptom was the sign-in page drawing its
   * sign-up form underneath the sign-in one, permanently — `login.js` toggles `hidden` and
   * nothing happened. Every panel, tab and banner in this UI is shown and hidden that way, so
   * the guard is load-bearing far beyond the page that exposed it.
   */
  test('the hidden attribute wins over display rules', () => {
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      'styles.css must force [hidden] to win, or toggling hidden does nothing');
  });

  test('motion is disabled for those who ask for that', () => {
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  /** The sign-in link to Keycloak is an <a>; a ring only on <button> would skip it. */
  test('focus-visible covers links, not only buttons', () => {
    const rule = /:where\(([^)]*)\):focus-visible/.exec(css);
    assert.ok(rule, 'no focus-visible rule found at all');
    assert.match(rule[1], /\ba\b/);
    assert.match(rule[1], /button/);
  });
});
