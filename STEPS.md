# Step API Reference

Every primitive registered on the unified Patchright image. Dispatch each
one through `POST /v1/sessions/:session_id/step`:

```http
POST /v1/sessions/<session_id>/step
Content-Type: application/json

{
  "type": "<step_name>",
  "config": { ... }
}
```

The Node service returns `{ "status": "ok", "result": { "ok": true, "output": {...} } }`
on success and `{ "status": "error", ..., "issues": [...] }` on schema
failures (Zod is strict; unknown keys reject loudly).

`GET /v1/steps` returns the live descriptor for every step including its
JSON Schema, so the PHP `AutomationClient` introspects this contract at
runtime instead of relying on this document to stay perfectly current.

## Conventions

- All parameter names are `snake_case`.
- All `*_ms` fields are integer milliseconds.
- All optional fields are documented with their default; missing keys
  fall back to that default.
- Schemas are `.strict()`: a typo (`dx` instead of `x`) returns HTTP 422.

---

## Navigation

### goto

Navigate the page to a URL and wait for the chosen lifecycle event.

| Parameter   | Type                               | Required | Default | Notes |
|-------------|------------------------------------|----------|---------|-------|
| `url`       | string (URL)                       | yes      |         |       |
| `wait_until`| `load \| domcontentloaded \| networkidle \| commit` | no       | `load`  |       |
| `timeout_ms`| integer                            | no       | `30000` | max `120000` |

Returns `{ url, status }` where `status` is the navigation response code (or
`null` for navigations that produced no main-frame response).

### wait_for

Wait for a selector, a load state, or a timeout before continuing. The
schema is a discriminated union on the `mode` field.

#### `mode: "selector"`

| Parameter     | Type     | Required | Default      |
|---------------|----------|----------|--------------|
| `selector`    | string   | yes      |              |
| `state`       | `attached \| detached \| visible \| hidden` | no | `visible` |
| `timeout_ms`  | integer  | no       | `10000`      |

#### `mode: "load_state"`

| Parameter     | Type                                          | Required | Default      |
|---------------|-----------------------------------------------|----------|--------------|
| `state`       | `load \| domcontentloaded \| networkidle`     | no       | `networkidle`|
| `timeout_ms`  | integer                                        | no       | `10000`      |

#### `mode: "timeout"`

| Parameter | Type    | Required |
|-----------|---------|----------|
| `ms`      | integer | yes      |

### reload

Reload the current page and wait for the chosen lifecycle event.

| Parameter   | Type                                                | Required | Default |
|-------------|-----------------------------------------------------|----------|---------|
| `wait_until`| `load \| domcontentloaded \| networkidle \| commit` | no       | `load`  |
| `timeout_ms`| integer                                             | no       |         |

Returns `{ url }`.

### go_back

Navigate back in the page history and wait for the chosen lifecycle event.

| Parameter   | Type                                                | Required | Default |
|-------------|-----------------------------------------------------|----------|---------|
| `wait_until`| `load \| domcontentloaded \| networkidle \| commit` | no       | `load`  |
| `timeout_ms`| integer                                             | no       |         |

Returns `{ url }`.

---

## Input

### click

Click an element matched by selector.

| Parameter     | Type                       | Required | Default |
|---------------|----------------------------|----------|---------|
| `selector`    | string                     | yes      |         |
| `button`      | `left \| right \| middle`  | no       | `left`  |
| `click_count` | integer (positive)         | no       | `1`     |
| `delay_ms`    | integer (>= 0)             | no       | `0`     |
| `force`       | boolean                    | no       | `false` |
| `timeout_ms`  | integer                    | no       | `10000` |

### type_text

Type text into an input matched by selector.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `selector`  | string  | yes      |         |
| `text`      | string  | yes      |         |
| `delay_ms`  | integer | no       | `0`     |
| `clear`     | boolean | no       | `false` |
| `timeout_ms`| integer | no       | `10000` |

### press_key

Send a single keyboard key (e.g. `Enter`, `Tab`) to the page.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `key`       | string  | yes      |         |
| `delay_ms`  | integer | no       | `0`     |

### select_option

Select one or more options on a select element.

| Parameter   | Type     | Required | Default |
|-------------|----------|----------|---------|
| `selector`  | string   | yes      |         |
| `values`    | string[] | yes      | (min 1) |
| `timeout_ms`| integer  | no       | `10000` |

### check

Toggle a checkbox or radio input to the desired state.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `selector`  | string  | yes      |         |
| `state`     | boolean | no       | `true`  |
| `timeout_ms`| integer | no       | `10000` |

### upload_file

Upload a base64-encoded file or remote URL to a file input.

| Parameter   | Type                  | Required | Default                       |
|-------------|-----------------------|----------|-------------------------------|
| `selector`  | string                | yes      |                               |
| `filename`  | string                | yes      |                               |
| `payload`   | string                | yes      |                               |
| `source`    | `base64 \| url`       | yes      |                               |
| `mime_type` | string                | no       | `application/octet-stream`    |
| `timeout_ms`| integer               | no       | `10000`                       |

---

## Inspection

### screenshot

Capture a viewport, full page, or single-element screenshot.

| Parameter   | Type                          | Required | Default    |
|-------------|-------------------------------|----------|------------|
| `mode`      | `viewport \| full \| element` | no       | `viewport` |
| `selector`  | string                        | no       |            |
| `encoding`  | `base64 \| binary`            | no       | `base64`   |
| `timeout_ms`| integer                       | no       | `10000`    |

Returns `{ bytes, encoding, data }` where `data` is base64 or binary as requested.

### html

Return the page or element outerHTML.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `selector`  | string  | no       |         |
| `timeout_ms`| integer | no       | `10000` |

Returns `{ html }`.

### text

Return the innerText of an element matched by selector.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `selector`  | string  | yes      |         |
| `timeout_ms`| integer | no       | `10000` |

Returns `{ text }`.

### attribute

Return a single attribute value for an element matched by selector.

| Parameter   | Type    | Required | Default |
|-------------|---------|----------|---------|
| `selector`  | string  | yes      |         |
| `name`      | string  | yes      |         |
| `timeout_ms`| integer | no       | `10000` |

Returns `{ name, value }`.

### evaluate_named

Evaluate a JavaScript expression in the page and store the named result.

| Parameter   | Type      | Required | Default |
|-------------|-----------|----------|---------|
| `name`      | string    | yes      |         |
| `expression`| string    | yes      |         |
| `args`      | unknown[] | no       | `[]`    |

The expression must be a function expression that gets invoked with `args`,
e.g. `() => document.title` or `(a, b) => a + b`. Returns `{ name, result }`.

### extract_dom_named

Extract attributes and text from every element matching a selector.

| Parameter     | Type     | Required | Default |
|---------------|----------|----------|---------|
| `name`        | string   | yes      |         |
| `selector`    | string   | yes      |         |
| `attrs`       | string[] | no       | `[]`    |
| `include_text`| boolean  | no       | `true`  |
| `timeout_ms`  | integer  | no       | `10000` |

Returns `{ name, rows: Array<{ [attr]: value, text?: string }> }`.

---

## Scroll & Viewport

### scroll_to

Scroll an element matched by selector into view.

| Parameter   | Type                                       | Required | Default  |
|-------------|--------------------------------------------|----------|----------|
| `selector`  | string                                     | yes      |          |
| `behavior`  | `auto \| smooth`                           | no       | `auto`   |
| `block`     | `start \| center \| end \| nearest`        | no       | `center` |
| `timeout_ms`| integer                                    | no       | `10000`  |

### scroll_by

Scroll the page by a pixel offset.

| Parameter | Type   | Required | Default |
|-----------|--------|----------|---------|
| `x`       | number | no       | `0`     |
| `y`       | number | no       | `0`     |

### scroll_until_plateau

Scroll repeatedly until the page height stops growing. Useful for
infinite-scroll pages.

| Parameter             | Type    | Required | Default |
|-----------------------|---------|----------|---------|
| `selector`            | string  | no       |         |
| `max_iterations`      | integer | no       | `20`    |
| `settle_ms`           | integer | no       | `750`   |
| `plateau_iterations`  | integer | no       | `2`     |
| `step_px`             | integer | no       | `1200`  |

Returns `{ iterations, final_height, plateau }`.

### scroll_modal

Scroll inside a modal until its inner content stops growing.

| Parameter         | Type    | Required | Default |
|-------------------|---------|----------|---------|
| `modal_selector`  | string  | yes      |         |
| `scroll_selector` | string  | no       |         |
| `max_iterations`  | integer | no       | `15`    |
| `settle_ms`       | integer | no       | `500`   |
| `step_px`         | integer | no       | `800`   |
| `timeout_ms`      | integer | no       | `10000` |

### set_viewport

Resize the page viewport.

| Parameter | Type             | Required |
|-----------|------------------|----------|
| `width`   | integer (>0)     | yes      |
| `height`  | integer (>0)     | yes      |

### set_user_agent

Persist a user-agent override for the next session boot. Patchright cannot
mutate the live UA, so this stores the value and returns
`applied_immediately: false`. Restart the session for the change to land.

| Parameter   | Type   | Required |
|-------------|--------|----------|
| `user_agent`| string | yes      |
