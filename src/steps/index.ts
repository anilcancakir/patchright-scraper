/**
 * Boot-time step registry. Every primitive defined under `src/steps/` is
 * imported here and registered with the shared {@link stepRegistry}.
 *
 * Custom plugins: drop a TypeScript file beside the category modules
 * that exports a `StepExecutor`, then add a `stepRegistry.register(...)`
 * call here. The image must be rebuilt for the new step to ship.
 *
 * Step shape mirrors Playwright's API one-to-one (camelCase names + a
 * single `locator` block per element-targeting step) so anyone fluent
 * in Playwright can author scenarios with no translation. Scraping
 * extensions that have no Playwright peer (extractDom, scrollUntilPlateau,
 * scrollModal, evaluate-with-name, solveCaptcha) keep their semantic
 * names and live alongside the canonical primitives.
 */
import { stepRegistry } from './registry.js';
import { goto, goBack, goForward, reload } from './navigation.js';
import {
  blur,
  check,
  click,
  dblclick,
  dragTo,
  fill,
  focus,
  hover,
  insertText,
  press,
  scrollIntoViewIfNeeded,
  selectOption,
  setInputFiles,
  type,
} from './input.js';
import {
  content,
  evaluate,
  extractDom,
  getAttribute,
  innerText,
  inputValue,
  screenshot,
} from './inspection.js';
import { scrollAndCollect, scrollBy, scrollModal, scrollUntilPlateau } from './scroll.js';
import {
  routeBlock,
  setExtraHTTPHeaders,
  setGeolocation,
  setOffline,
  setUserAgent,
  setViewportSize,
} from './page.js';
import {
  waitForFunction,
  waitForLoadState,
  waitForSelector,
  waitForTimeout,
  waitForURL,
} from './wait.js';
import { expect } from './expect.js';
import { solveCaptcha } from './captcha.js';

const builtIns = [
  // Navigation
  goto,
  reload,
  goBack,
  goForward,
  // Waits
  waitForSelector,
  waitForLoadState,
  waitForTimeout,
  waitForURL,
  waitForFunction,
  // Actions
  click,
  dblclick,
  fill,
  insertText,
  type,
  press,
  hover,
  focus,
  blur,
  dragTo,
  scrollIntoViewIfNeeded,
  selectOption,
  check,
  setInputFiles,
  // Reads
  screenshot,
  content,
  innerText,
  getAttribute,
  inputValue,
  evaluate,
  extractDom,
  // Scroll helpers
  scrollBy,
  scrollUntilPlateau,
  scrollModal,
  scrollAndCollect,
  // Page-level config
  setViewportSize,
  setUserAgent,
  setExtraHTTPHeaders,
  setOffline,
  setGeolocation,
  routeBlock,
  // Assertions (scenario guards)
  expect,
  // Anti-bot helpers
  solveCaptcha,
];

for (const executor of builtIns) {
  stepRegistry.register(executor);
}

export { stepRegistry } from './registry.js';
export type { SessionState, StepContext, StepExecutor, StepResult } from './types.js';
