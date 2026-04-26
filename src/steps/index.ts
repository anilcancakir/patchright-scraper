/**
 * Boot-time step registry. Every primitive defined under `src/steps/` is
 * imported here and registered with the shared {@link stepRegistry}.
 *
 * Custom plugins: drop a TypeScript file beside the category modules
 * that exports a `StepExecutor`, then add a `stepRegistry.register(...)`
 * call here. The image must be rebuilt for the new step to ship.
 */
import { stepRegistry } from './registry.js';
import { go_back, goto, reload, wait_for } from './navigation.js';
import { check, click, press_key, select_option, type_text, upload_file } from './input.js';
import { attribute, evaluate_named, extract_dom_named, html, screenshot, text } from './inspection.js';
import { scroll_by, scroll_modal, scroll_to, scroll_until_plateau, set_user_agent, set_viewport } from './scroll.js';

const builtIns = [
  goto,
  wait_for,
  reload,
  go_back,
  click,
  type_text,
  press_key,
  select_option,
  check,
  upload_file,
  screenshot,
  html,
  text,
  attribute,
  evaluate_named,
  extract_dom_named,
  scroll_to,
  scroll_by,
  scroll_until_plateau,
  scroll_modal,
  set_viewport,
  set_user_agent,
];

for (const executor of builtIns) {
  stepRegistry.register(executor);
}

export { stepRegistry } from './registry.js';
export type { StepExecutor, StepContext, StepResult, SessionState } from './types.js';
