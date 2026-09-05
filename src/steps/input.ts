import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'patchright';
import { z } from 'zod';
import { LocatorSpec, type LocatorCandidate, resolveLocator } from './locator.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

/**
 * Locator candidates arrive normalised to a list by LocatorSpec's
 * transform, so every step reads the same shape whether the recipe
 * wrote one object or a fallback chain.
 */
type Candidates = LocatorCandidate[];

/**
 * Default gap between keystrokes on the `type` step, in milliseconds.
 *
 * Was 0, which sent a 40-character field as 40 key events with no gap
 * between them. That is a behavioural signal independent of how each
 * event was dispatched, and it is the axis a 2026-09-03 CDP-versus-XTEST
 * measurement explicitly could not rule out: that A/B held provenance
 * constant across 180 trials, found no separation, and left timing as
 * the untested variable.
 *
 * v0.6.2 shipped this at 100, roughly half the measured population rate:
 * Dhakal et al. (CHI 2018, 136M keystrokes, 168k participants) found a
 * mean inter-key interval of 238.66ms (51.56 WPM). 240 rounds that to a
 * value the projection guard below divides evenly against.
 *
 * A recipe that genuinely wants the old behaviour writes `delay: 0`,
 * which is treated as an explicit opt-out rather than as a tiny gap.
 */
export const KEYSTROKE_MEAN_MS = 240;

/**
 * Log-normal shape parameter (sigma of the underlying normal) for
 * {@link sampleKeystrokeGap}.
 *
 * Gonzalez et al. (PMC8606350) tested 14 candidate distributions against
 * three public keystroke datasets: Gaussian is "rejected very often",
 * log-logistic wins most often and log-normal is a close second. Neither
 * paper hands over a fitted sigma, so 0.6 is an engineering choice sized
 * for this sampler's own test suite: large enough that 1000 draws
 * reliably produce a value past 2x the mean (the heavy tail a clamped
 * uniform band cannot produce at all), small enough that the sample mean
 * still converges tightly on the configured mean.
 */
const KEYSTROKE_LOGNORMAL_SIGMA = 0.6;

/**
 * Mean time one key stays down, in milliseconds.
 *
 * Dhakal et al. again, the same 136M-keystroke dataset the gap above is
 * sized from: keypress duration 116.25ms, SD 23.88, right-skewed
 * (skewness 0.8). The paper notes it barely moves with typing speed,
 * staying inside 80 to 150ms between the fastest and slowest deciles of
 * 168,960 participants, so this is close to a constant of the hand
 * rather than a per-person style.
 *
 * v0.6.7 held every key for nothing at all. Playwright's `delay` is the
 * hold, not the gap (`playwright-core/src/server/input.ts` at `b4e7c87`:
 * `press` does `down`, `wait(delay)`, `up`), and the cadence work passed
 * none of it, sleeping between characters instead. Measured on the live
 * pool container 2026-09-05: 1 to 2ms per key, roughly five standard
 * deviations below this mean and outside the range that paper observed.
 */
export const KEY_HOLD_MEAN_MS = 116;

/**
 * Mean time a mouse button stays down, in milliseconds.
 *
 * No large-sample measurement of mousedown-to-mouseup was found, so this
 * is anchored on {@link KEY_HOLD_MEAN_MS}: a click and a keypress are the
 * same motor act, one finger flexing and releasing, and Dhakal is the
 * largest published measurement of that act. Trimmed to 90 because a
 * mouse button has less travel than a key switch, which is a judgement
 * and not a measurement, and it is written down here so the next person
 * knows which part is sourced.
 *
 * Arkose's own biometrics tooling is reported to bucket click duration as
 * "30-100ms common human, above 100ms very human". That page refused
 * connections on three attempts from here, so it is corroboration we
 * could not read, never the source.
 *
 * Measured before the change: 0.5ms.
 */
export const CLICK_HOLD_MEAN_MS = 90;

/**
 * Log-normal shape parameter for a hold time.
 *
 * Dhakal's hold has CV 23.88 / 116.25 = 0.205, and for a log-normal
 * `CV = sqrt(exp(sigma^2) - 1)`, so sigma 0.2 reproduces it. That is a
 * third of {@link KEYSTROKE_LOGNORMAL_SIGMA}, and deliberately: the gap
 * between keys genuinely varies by a factor of several (CV 0.47 in the
 * same paper) while the hold does not. Sampling a hold with the gap's
 * spread would produce 20ms and 400ms presses, neither of which that
 * dataset contains.
 */
const HOLD_LOGNORMAL_SIGMA = 0.2;

/**
 * One draw, in milliseconds, from a log-normal parameterised so its mean
 * equals `mean` and its shape is `sigma`.
 *
 * Box-Muller turns two uniform draws into one standard normal, which is
 * then exponentiated. `mu` is solved from the log-normal mean identity
 * `E[X] = exp(mu + sigma^2 / 2)` so the distribution's mean lands on the
 * caller's `mean` argument rather than on `mean` shifted by the shape
 * parameter.
 */
function sampleLogNormal(mean: number, sigma: number): number {
  if (mean <= 0) {
    return 0;
  }

  // u1 excludes 0 (Math.random() can return it) so log(u1) stays finite.
  const u1 = 1 - Math.random();
  const u2 = Math.random();
  const standardNormal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  const mu = Math.log(mean) - (sigma ** 2) / 2;

  return Math.exp(mu + sigma * standardNormal);
}

/**
 * One inter-keystroke gap, in milliseconds.
 *
 * Exported for its own test: the shape that matters (heavy-tailed and
 * right-skewed, not a clamped band) is worth pinning directly rather
 * than inferring from wall-clock timings inside a step test.
 */
export function sampleKeystrokeGap(mean: number): number {
  return Math.round(sampleLogNormal(mean, KEYSTROKE_LOGNORMAL_SIGMA));
}

/**
 * One hold duration, in milliseconds, floored at 1.
 *
 * Floored rather than rounded to zero, because zero is the exact value
 * this function exists to stop emitting.
 */
export function sampleHoldMs(mean: number): number {
  if (mean <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(sampleLogNormal(mean, HOLD_LOGNORMAL_SIGMA)));
}

/**
 * Baseline number of points a pointer draws on its way to a `click`,
 * `dblclick` or `hover` target, replacing Playwright's own default of a
 * single teleport point: `move(x, y, { steps = 1 })` in playwright-core
 * `input.ts:216-290` interpolates exactly one point when `steps` is
 * omitted, so what ships without this is one instantaneous `mousemove`
 * at the destination rather than a path.
 *
 * Sized off Plesner et al. (COMPSAC 2024, arXiv:2409.08831), live against
 * reCAPTCHAv2: no movement averaged 19.23 challenges to pass, straight-line
 * movement ~7, Bezier movement 8.38 (t = 0.58, p = 0.57 against
 * straight-line: not significant). Movement is what matters and curve
 * shape is not measurably better, which is also why the macro path stays
 * a straight line rather than a Bezier: BeCAPTCHA-Mouse (arXiv:2005.00890)
 * and DMTG (arXiv:2410.18233) both classify Bezier-family synthetic
 * trajectories as non-human at 88 to 99.9 per cent, so a curve generator
 * would be trading an unmeasured benefit for a measured tell.
 *
 * A count on its own is not the whole story, and the first version of
 * this got the rest wrong. It handed the count to Playwright's `steps`
 * option, which divides the line into EQUAL parts, and a page reading the
 * result back inside the production container on 2026-09-05 saw
 * `dx = [50,50,50,50,50,50,50,50,50,50,50]`: constant displacement, which
 * is constant velocity, which no hand produces. See
 * {@link movePointerToBoxCentre} for what replaced it.
 */
export const DEFAULT_POINTER_STEPS = 12;

/**
 * Largest displacement, in pixels, the path aims for between two
 * consecutive points.
 *
 * Chrome delivers `mousemove` on the frame boundary, so displacement per
 * point IS velocity in pixels per ~16.6ms. Measured in the container: the
 * observed interval was ~16.6ms whether we dispatched with no sleep at
 * all, with a 7ms sleep, or through Playwright's own interpolation, and a
 * 40ms sleep came back as ~50ms, three whole frames. Sub-frame timing is
 * therefore invisible to the page, for a human as much as for us, which
 * is why this file spends its effort on geometry and not on clocks.
 *
 * The ease profile peaks near 1.5x the mean step, so a mean held at 40px
 * per frame peaks near 60, or 3.6px/ms. Arkose's biometrics tooling is
 * reported to cap a human hand at about 5px/ms; that page was unreachable
 * from here, so the number is a target with headroom rather than a line
 * we are hugging.
 */
export const POINTER_MAX_STEP_PX = 40;

/**
 * Smallest displacement the path aims for between two consecutive points.
 *
 * Below this the points stop being a movement and start being a cluster
 * in one place. Arkose's own collector discards a move under 5px
 * (`MOUSE_THRESHOLD = 5` in its published sample), so points closer than
 * that are not even recorded and only serve to make our own dispatch
 * pattern denser than a hand's.
 */
const POINTER_MIN_STEP_PX = 8;

/**
 * Below this travel the pointer is treated as already there: no approach
 * is drawn at all, only the settle.
 *
 * This is the second half of the bug measured on 2026-09-05. Clicking the
 * same element twice asked Playwright to interpolate a zero-length line
 * into twelve equal parts, and it duly emitted ELEVEN `mousemove` events
 * at the identical coordinate. A hand that is already on the button does
 * not re-approach it; it rests, with tremor.
 */
const POINTER_MIN_TRAVEL_PX = 4;

/** Hard ceiling on points, so a viewport-crossing move still ends. */
const POINTER_MAX_POINTS = 60;

/**
 * Milliseconds one point costs, for budgeting purposes.
 *
 * Not a sleep. Chrome delivers `mousemove` on the frame boundary, so a
 * point costs one frame of wall clock whether or not we wait for it, and
 * a 60Hz frame is 16.6ms.
 */
const POINTER_FRAME_MS = 17;

/**
 * Share of the action budget the approach may spend.
 *
 * `resolveLocator` floors the action budget at 1000ms, and an unbounded
 * 60-point path costs a whole second, so a long travel on a tight step
 * would consume the entire floor and the click behind it would fail as
 * `Timeout 1000ms exceeded` with the path, not the page, as the cause.
 * That failure mode is the one the reserve in `locator.ts` exists to
 * prevent, and it would have been reintroduced here.
 */
const POINTER_BUDGET_SHARE = 0.4;

/** Bounds of the overshoot past the target before the correction back. */
const OVERSHOOT_MIN_PX = 2;
const OVERSHOOT_MAX_PX = 6;

/**
 * Largest sideways deviation, in pixels, of an intermediate point from
 * the straight line joining start to target.
 *
 * This is tremor, not curvature: it is resampled per point rather than
 * following a smooth function, so the macro shape stays the straight line
 * the sources above argue for while the individual points stop sharing
 * one exact y. The measured path had every intermediate point on
 * `y = 159`, which is a ruler rather than an arm.
 */
const POINTER_TREMOR_PX = 2;

const PointerSteps = z.number().int().positive().default(DEFAULT_POINTER_STEPS);

/**
 * Largest pixel drift of the settle hop away from the target centre.
 * Small on purpose: this is the last-moment correction of a hand that has
 * already arrived, not a second approach.
 */
const SETTLE_DRIFT_PX = 3;

/**
 * Signed 1 to {@link SETTLE_DRIFT_PX} pixel offset for the settle hop.
 * Randomised because a settle that lands on the same two pixels of every
 * click across every session is itself a constant worth matching on.
 */
function settleOffset(): number {
  const magnitude = 1 + Math.floor(Math.random() * SETTLE_DRIFT_PX);

  return Math.random() < 0.5 ? -magnitude : magnitude;
}

/**
 * Where the pointer was left, per page.
 *
 * Playwright does not expose the cursor position, and the first version
 * of the path used that as the reason to delegate interpolation to its
 * `steps` option: you cannot hand-roll a path from a point you do not
 * know. Remembering it removes the objection, and remembering is safe
 * because nothing else in this process moves the mouse.
 *
 * A `WeakMap` so a closed page's entry goes with it. The default is
 * `0,0`, which is where Playwright's own cursor starts.
 */
const pointerPositions = new WeakMap<Page, { x: number; y: number }>();

/** Dispatch one move and remember where it left the pointer. */
async function movePointerTo(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  pointerPositions.set(page, { x, y });
}

/**
 * Smoothstep, the cheapest ease that is slow at both ends and fast in the
 * middle. Applied to the interpolation parameter it turns equal time
 * slices into unequal distances, which is the whole point: a hand
 * accelerates away from rest and decelerates into the target, and the
 * page reads that as displacement per frame.
 */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * How many points to draw for a given travel distance.
 *
 * Two pressures, opposite ends. A long path divided into a fixed count
 * teleports tens of pixels per frame, so the count has to grow with
 * distance ({@link POINTER_MAX_STEP_PX}). A short hop divided into the
 * same fixed count emits a dense cluster inside a few pixels, so the
 * count has to shrink with it ({@link POINTER_MIN_STEP_PX}).
 */
function pointerPointCount(distance: number, requested: number, budgetMs: number): number {
  const dense = Math.ceil(distance / POINTER_MAX_STEP_PX);
  const sparse = Math.ceil(distance / POINTER_MIN_STEP_PX);
  const affordable = Math.floor((budgetMs * POINTER_BUDGET_SHARE) / POINTER_FRAME_MS);

  return Math.max(
    2,
    Math.min(POINTER_MAX_POINTS, affordable, Math.max(dense, Math.min(requested, sparse))),
  );
}

/**
 * Approach the target's centre, overshoot it, and pull back onto it, so
 * the page sees a movement with a velocity profile instead of a ruler.
 *
 * Three properties, each answering something measured on 2026-09-05
 * against a real page inside the production container:
 *
 *  - **Unequal steps.** `dx` was `[50,50,...]` on every frame. The points
 *    are now placed along an ease, so the middle of the movement is
 *    several times faster than its ends.
 *  - **No cluster on one pixel.** Clicking the same element twice emitted
 *    eleven moves at the identical coordinate, because a zero-length line
 *    still got twelve equal parts. Under {@link POINTER_MIN_TRAVEL_PX} the
 *    approach is skipped entirely.
 *  - **Overshoot, then correct.** The hand lands a few pixels past the
 *    target and pulls back, rather than stopping dead on the centre. The
 *    settle hop that shipped in v0.6.6 already refused to hold perfectly
 *    still; this makes the arrival itself imperfect too.
 *
 * Deliberately no sleeps. Chrome delivers `mousemove` on the frame
 * boundary, so a sub-frame sleep changes nothing a page can see and a
 * multi-frame one only makes the movement slower; see
 * {@link POINTER_MAX_STEP_PX} for the measurement. That also keeps this
 * function what it was: a run of fire-and-forget CDP dispatches with
 * nothing to bound against the step's `remainingMs` budget.
 *
 * A `null` box means a detached or not-yet-rendered element. The move is
 * skipped rather than thrown: the locator action that follows has its own
 * wait/retry against `remainingMs` and may still land once the DOM
 * settles, and refusing a click that would otherwise have worked is worse
 * than falling back to Playwright's own implicit single-point move.
 */
async function movePointerToBoxCentre(
  page: Page,
  box: { x: number; y: number; width: number; height: number } | null,
  steps: number,
  budgetMs: number,
): Promise<void> {
  if (box === null) {
    return;
  }

  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  const from = pointerPositions.get(page) ?? { x: 0, y: 0 };
  const dx = centreX - from.x;
  const dy = centreY - from.y;
  const distance = Math.hypot(dx, dy);

  if (distance >= POINTER_MIN_TRAVEL_PX) {
    const points = pointerPointCount(distance, steps, budgetMs);
    // Unit vector along the travel, and its perpendicular, so the
    // overshoot runs past the target and the tremor runs across it.
    const alongX = dx / distance;
    const alongY = dy / distance;
    const overshoot = OVERSHOOT_MIN_PX + Math.random() * (OVERSHOOT_MAX_PX - OVERSHOOT_MIN_PX);
    const landingX = centreX + alongX * overshoot;
    const landingY = centreY + alongY * overshoot;

    for (let i = 1; i <= points; i++) {
      const progress = easeInOut(i / points);
      // The last point is the overshoot itself and carries no tremor;
      // the correction below is what moves off it.
      const tremor = i === points ? 0 : (Math.random() * 2 - 1) * POINTER_TREMOR_PX;

      await movePointerTo(
        page,
        Math.round(from.x + (landingX - from.x) * progress - alongY * tremor),
        Math.round(from.y + (landingY - from.y) * progress + alongX * tremor),
      );
    }
  }

  await movePointerTo(page, centreX + settleOffset(), centreY + settleOffset());
  await movePointerTo(page, centreX, centreY);
}

export const click: StepExecutor = {
  name: 'click',
  description: 'Click an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clickCount: z.number().int().positive().default(1),
      delay: z.number().int().nonnegative().default(CLICK_HOLD_MEAN_MS),
      force: z.boolean().default(false),
      pointerSteps: PointerSteps,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      button: 'left' | 'right' | 'middle';
      clickCount: number;
      delay: number;
      force: boolean;
      pointerSteps: number;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    const box = await target.locator.boundingBox({ timeout: target.remainingMs });
    await movePointerToBoxCentre(ctx.page, box, c.pointerSteps, target.remainingMs);
    await target.locator.click({
      button: c.button,
      clickCount: c.clickCount,
      // Playwright applies this between mousedown and mouseup, so it is
      // the button hold. Sampled around the recipe's value rather than
      // used as one, because a constant hold is its own signal; `0` stays
      // an exact opt-out.
      delay: sampleHoldMs(c.delay),
      force: c.force,
      timeout: target.remainingMs,
    });

    return { ok: true, output: { clicked: true, locatorIndex: target.index } };
  },
};

export const dblclick: StepExecutor = {
  name: 'dblclick',
  description: 'Double-click an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      delay: z.number().int().nonnegative().default(CLICK_HOLD_MEAN_MS),
      force: z.boolean().default(false),
      pointerSteps: PointerSteps,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      button: 'left' | 'right' | 'middle';
      delay: number;
      force: boolean;
      pointerSteps: number;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    const box = await target.locator.boundingBox({ timeout: target.remainingMs });
    await movePointerToBoxCentre(ctx.page, box, c.pointerSteps, target.remainingMs);
    await target.locator.dblclick({
      button: c.button,
      delay: sampleHoldMs(c.delay),
      force: c.force,
      timeout: target.remainingMs,
    });

    return { ok: true, output: { clicked: true, locatorIndex: target.index } };
  },
};

export const fill: StepExecutor = {
  name: 'fill',
  description:
    'Fill a native input/textarea instantly. Does NOT work on rich contentEditable editors (Draft.js, Lexical, ProseMirror); use insertText there.',
  schema: z
    .object({
      locator: LocatorSpec,
      value: z.string(),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; value: string; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.fill(c.value, { timeout: target.remainingMs });

    return { ok: true, output: { length: c.value.length, locatorIndex: target.index } };
  },
};

export const insertText: StepExecutor = {
  name: 'insertText',
  description:
    'Commit text into the focused element the way an IME does. The reliable way into rich contentEditable editors that ignore fill().',
  schema: z
    .object({
      locator: LocatorSpec.optional(),
      text: z.string(),
      clear: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  /**
   * `keyboard.insertText` maps to CDP `Input.insertText`, which commits
   * the whole string as a single composition event rather than
   * synthesising per-character keydowns.
   *
   * Two reasons that matters. Rich editors built on `beforeinput`
   * (Draft.js, Lexical, ProseMirror) ignore `fill()` entirely because it
   * sets a value no controlled component reads. And per-character typing
   * races the editor's own mount: the first characters land before the
   * handler is listening and vanish, which reads like a flaky selector.
   *
   * When a locator is supplied it is CLICKED, not focused. A rich editor
   * keys its edit mode off a native click-sourced focus event, so
   * `focus()` alone leaves it inert and any submit button downstream
   * stays disabled no matter what was typed.
   */
  async execute(ctx, config) {
    const c = config as {
      locator?: Candidates;
      text: string;
      clear: boolean;
      timeout: number;
    };

    let locatorIndex: number | null = null;

    if (c.locator !== undefined) {
      const target = await resolveLocator(ctx.page, c.locator, c.timeout);
      await target.locator.click({ timeout: target.remainingMs });
      locatorIndex = target.index;
    }

    if (c.clear) {
      // Select-all + Backspace rather than fill(''), which is the exact
      // call a contentEditable editor ignores. Both modifiers are sent
      // because the container is Linux and an operator recording a
      // recipe on macOS would otherwise write one that only works there.
      await ctx.page.keyboard.press('ControlOrMeta+a');
      await ctx.page.keyboard.press('Backspace');
    }

    await ctx.page.keyboard.insertText(c.text);

    return { ok: true, output: { length: c.text.length, locatorIndex } };
  },
};

/**
 * Refuse a string that cannot be typed inside the budget, rather than
 * overrunning it.
 *
 * Playwright's own `pressSequentially` bounds itself against the
 * timeout; the per-character loop below does not, so a long string at a
 * human gap would hold the browser far past the declared timeout. Both
 * levers are named in the message because either one fixes it and the
 * right choice depends on whether the text or the pace is the point.
 */
function assertTypingFitsBudget(text: string, delay: number, remainingMs: number): void {
  const projectedMs = text.length * delay;

  if (projectedMs > remainingMs) {
    throw new Error(
      `Typing ${text.length} characters at ~${delay}ms each needs about ${projectedMs}ms, ` +
        `but only ${remainingMs}ms of the step budget is left. ` +
        'Raise "timeout" or lower "delay" (0 types instantly).',
    );
  }
}

/**
 * Type into the already-focused element one character at a time, with a
 * sampled gap between keys.
 *
 * `keyboard.type` sends the real keydown/keypress/keyup triple for one
 * character. `keyboard.insertText` would deliver the same text through
 * Chromium's `ImeCommitText` with no key events at all, which is what
 * every text-entry path here used to do.
 *
 * Caller establishes focus first, and how it does that is not the same
 * everywhere: a rich contentEditable needs a real click, a native input
 * is happy with `focus()`.
 */
async function typeWithCadence(page: Page, text: string, delay: number): Promise<void> {
  for (const char of text) {
    // `keyboard.type` rather than `keyboard.press`, one character at a
    // time, and the choice is load-bearing: `type` falls back to
    // `insertText` for a character the US layout does not carry
    // (playwright-core `input.ts`, `usKeyboardLayout.has(char)`), while
    // `press` throws on it. A Turkish handle typed through `press` would
    // die on the first non-ASCII letter.
    //
    // The option is the HOLD, not the gap: `press` does `down`,
    // `wait(delay)`, `up`, and `type` forwards its delay into `press` per
    // character. v0.6.7 passed none of it and slept afterwards instead,
    // which is how the hold ended up at 1 to 2ms.
    const startedAt = Date.now();
    await page.keyboard.type(char, { delay: sampleHoldMs(KEY_HOLD_MEAN_MS) });

    // The gap is the keydown-to-keydown interval the recipes are budgeted
    // against, and the hold sits INSIDE it, so what is left to sleep is
    // the remainder. Adding the hold on top would stretch every stored
    // recipe past the timeout its author measured against.
    //
    // Measured elapsed rather than the sampled hold, because the round
    // trip costs more than the hold it carries: subtracting the sample
    // left the real interval at ~285ms against a 240ms target, which ate
    // enough of the 90s post budget (67s projected, 80s actual) to make a
    // heavy draw a failed post rather than a slow one.
    const remainder = sampleKeystrokeGap(delay) - (Date.now() - startedAt);

    if (remainder > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainder));
    }
  }
}

export const type: StepExecutor = {
  name: 'type',
  description: 'Type text character-by-character with optional per-key delay.',
  schema: z
    .object({
      locator: LocatorSpec,
      text: z.string(),
      delay: z.number().int().nonnegative().default(KEYSTROKE_MEAN_MS),
      clear: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      text: string;
      delay: number;
      clear: boolean;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    if (c.clear) {
      // Was fill(''), which silently does nothing on a contentEditable
      // and left the old text in place for the typed text to append to.
      await target.locator.click({ timeout: target.remainingMs });
      await ctx.page.keyboard.press('ControlOrMeta+a');
      await ctx.page.keyboard.press('Backspace');
    }

    if (c.delay <= 0) {
      // Explicit opt-out. One call, one burst, no gaps, and Playwright
      // bounds the whole operation itself. pressSequentially rather than
      // the deprecated type(): same key events, same options, still
      // supported.
      await target.locator.pressSequentially(c.text, { delay: 0, timeout: target.remainingMs });

      return { ok: true, output: { length: c.text.length, locatorIndex: target.index } };
    }

    assertTypingFitsBudget(c.text, c.delay, target.remainingMs);

    // `focus()`, not `click()`: this step also serves native inputs, and
    // a click carries a pointer path plus a real mousedown that a plain
    // field does not need. A rich contentEditable keys its edit mode off
    // a click-sourced focus event and stays inert here, so a recipe
    // driving one puts its own `click` step in front. The three X
    // recipes do exactly that.
    await target.locator.focus({ timeout: target.remainingMs });
    await typeWithCadence(ctx.page, c.text, c.delay);

    return { ok: true, output: { length: c.text.length, locatorIndex: target.index } };
  },
};

export const press: StepExecutor = {
  name: 'press',
  description: 'Press a single keyboard key, optionally focused on an element first.',
  schema: z
    .object({
      key: z.string().min(1),
      locator: LocatorSpec.optional(),
      // The hold, per Playwright's own `press`. The two `press: Enter`
      // steps in the X login recipe were the last key events left at a
      // zero hold once the credentials moved to `type`.
      delay: z.number().int().nonnegative().default(KEY_HOLD_MEAN_MS),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      key: string;
      locator?: Candidates;
      delay: number;
      timeout: number;
    };
    const hold = sampleHoldMs(c.delay);

    if (c.locator !== undefined) {
      const target = await resolveLocator(ctx.page, c.locator, c.timeout);
      await target.locator.press(c.key, { delay: hold, timeout: target.remainingMs });

      return { ok: true, output: { key: c.key, locatorIndex: target.index } };
    }

    await ctx.page.keyboard.press(c.key, { delay: hold });

    return { ok: true, output: { key: c.key, locatorIndex: null } };
  },
};

export const hover: StepExecutor = {
  name: 'hover',
  description: 'Hover the cursor over an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      force: z.boolean().default(false),
      pointerSteps: PointerSteps,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      force: boolean;
      pointerSteps: number;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    const box = await target.locator.boundingBox({ timeout: target.remainingMs });
    await movePointerToBoxCentre(ctx.page, box, c.pointerSteps, target.remainingMs);
    await target.locator.hover({ force: c.force, timeout: target.remainingMs });

    return { ok: true, output: { hovered: true, locatorIndex: target.index } };
  },
};

export const focus: StepExecutor = {
  name: 'focus',
  description: 'Focus an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.focus({ timeout: target.remainingMs });

    return { ok: true, output: { focused: true, locatorIndex: target.index } };
  },
};

export const blur: StepExecutor = {
  name: 'blur',
  description: 'Blur an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.blur({ timeout: target.remainingMs });

    return { ok: true, output: { blurred: true, locatorIndex: target.index } };
  },
};

export const dragTo: StepExecutor = {
  name: 'dragTo',
  description: 'Drag the source element to the target element.',
  schema: z
    .object({
      locator: LocatorSpec,
      target: LocatorSpec,
      force: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      target: Candidates;
      force: boolean;
      timeout: number;
    };
    const source = await resolveLocator(ctx.page, c.locator, c.timeout);
    const destination = await resolveLocator(ctx.page, c.target, source.remainingMs);

    await source.locator.dragTo(destination.locator, {
      force: c.force,
      timeout: destination.remainingMs,
    });

    return {
      ok: true,
      output: {
        dragged: true,
        locatorIndex: source.index,
        targetLocatorIndex: destination.index,
      },
    };
  },
};

export const scrollIntoViewIfNeeded: StepExecutor = {
  name: 'scrollIntoViewIfNeeded',
  description: 'Scroll the element into view if it is not already.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.scrollIntoViewIfNeeded({ timeout: target.remainingMs });

    return { ok: true, output: { scrolled: true, locatorIndex: target.index } };
  },
};

export const selectOption: StepExecutor = {
  name: 'selectOption',
  description: 'Select one or more options on a <select> element.',
  schema: z
    .object({
      locator: LocatorSpec,
      values: z.array(z.string()).min(1),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; values: string[]; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    const selected = await target.locator.selectOption(c.values, {
      timeout: target.remainingMs,
    });

    return { ok: true, output: { selected, locatorIndex: target.index } };
  },
};

export const check: StepExecutor = {
  name: 'check',
  description: 'Toggle a checkbox or radio input to the desired state.',
  schema: z
    .object({
      locator: LocatorSpec,
      state: z.boolean().default(true),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; state: boolean; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    if (c.state) {
      await target.locator.check({ timeout: target.remainingMs });
    } else {
      await target.locator.uncheck({ timeout: target.remainingMs });
    }

    return { ok: true, output: { state: c.state, locatorIndex: target.index } };
  },
};

export const setInputFiles: StepExecutor = {
  name: 'setInputFiles',
  description: 'Attach a base64-encoded file or remote URL to an <input type=file>.',
  schema: z
    .object({
      locator: LocatorSpec,
      source: z.enum(['base64', 'url']),
      payload: z.string(),
      filename: z.string(),
      mimeType: z.string().default('application/octet-stream'),
      timeout: TimeoutMs.default(30_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: Candidates;
      source: 'base64' | 'url';
      payload: string;
      filename: string;
      mimeType: string;
      timeout: number;
    };

    let buffer: Buffer;
    if (c.source === 'base64') {
      buffer = Buffer.from(c.payload, 'base64');
    } else {
      const response = await fetch(c.payload, { signal: AbortSignal.timeout(c.timeout) });
      if (!response.ok) {
        return { ok: false, error: `setInputFiles: fetch failed ${response.status}` };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const dir = mkdtempSync(join(tmpdir(), 'patchright-upload-'));
    const tmpFile = join(dir, c.filename);
    writeFileSync(tmpFile, buffer);

    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    try {
      await target.locator.setInputFiles({
        name: c.filename,
        mimeType: c.mimeType,
        buffer,
      });
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore tmp cleanup errors
      }
    }

    return {
      ok: true,
      output: { filename: c.filename, bytes: buffer.byteLength, locatorIndex: target.index },
    };
  },
};

/**
 * Fill a multi-part composer, adding each new part as it goes.
 *
 * A thread cannot be expressed as a static step list, because the number
 * of parts is an input and the scenario engine has no loop. It also
 * cannot be faked with `try_branch`: that catches a
 * ScenarioStepFailedException and cannot tell "there is no part 4" from
 * "the add button broke", so a five-part thread would quietly post as
 * two and report success. The whole reason for composing a thread in one
 * pass rather than as a reply chain is that it is all-or-nothing, and
 * swallowing a real failure gives that away.
 *
 * The ORDER here is measured, not assumed. On X the add control is only
 * present while the last part has content: it disappears the moment a
 * new empty part is created and returns once that part is typed into.
 * So each iteration types first and adds second, never two adds in a
 * row. Getting this backwards produces a recipe that works for two
 * parts and hangs on three.
 *
 * `editorTemplate` keeps the site's naming in the recipe where it can be
 * repaired without a release, while the loop lives here where it has to.
 * `{index}` is substituted per part (X names them tweetTextarea_0,
 * tweetTextarea_1, ...).
 *
 * Nothing is submitted. The recipe still owns the click that publishes,
 * so a caller can inspect or abandon a composed thread.
 *
 * `timeout` bounds locator resolution and nothing else, which is what it
 * has always meant here, and the typing loop is deliberately NOT checked
 * against it. Reusing it as a typing budget would give an existing key a
 * new meaning and refuse every stored thread recipe the moment this
 * ships: the live one carries `timeout: 20000`, and one 280-character
 * part at the 240 ms default needs about 67,000. `type` can afford that
 * guard because its recipes were written alongside it; this one cannot.
 *
 * The backstop is therefore the job timeout (1500 s on
 * `RunSocialActionJob`). Worst case at the recipe's five-part policy
 * ceiling is about 336 s of typing, comfortably inside it. The schema's
 * own 25-part ceiling is not: a maxed thread would exceed the job and
 * cost a draft, which is the same price every other failure here pays.
 */
export const composeThread: StepExecutor = {
  name: 'composeThread',
  description:
    'Type each part of a multi-part composer, clicking the add control between parts. Does not submit.',
  schema: z
    .object({
      editorTemplate: z.string().min(1),
      addButton: LocatorSpec,
      parts: z.array(z.string().min(1)).min(1).max(25),
      delay: z.number().int().nonnegative().default(KEYSTROKE_MEAN_MS),
      timeout: TimeoutMs.default(20_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      editorTemplate: string;
      addButton: Candidates;
      parts: string[];
      delay: number;
      timeout: number;
    };

    for (const [index, part] of c.parts.entries()) {
      if (index > 0) {
        const add = await resolveLocator(ctx.page, c.addButton, c.timeout);
        await add.locator.click({ timeout: add.remainingMs });
      }

      const selector = c.editorTemplate.replaceAll('{index}', String(index));
      const editor = await resolveLocator(ctx.page, [{ selector, nth: 0 }], c.timeout);

      // Clicked rather than focused: a rich editor keys its edit mode
      // off a real click-sourced focus event and stays inert otherwise.
      await editor.locator.click({ timeout: editor.remainingMs });

      if (c.delay <= 0) {
        // Explicit opt-out, and the behaviour every stored thread recipe
        // had before this key existed. Commits the part the way an IME
        // does, with no key events at all.
        await ctx.page.keyboard.insertText(part);
        continue;
      }

      await typeWithCadence(ctx.page, part, c.delay);
    }

    return { ok: true, output: { parts: c.parts.length } };
  },
};
