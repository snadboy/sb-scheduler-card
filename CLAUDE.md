# sb-scheduler-card — session notes

Split out of [`snadboy/sb-scheduler`](https://github.com/snadboy/sb-scheduler)
on 2026-09-20 (it had lived in that repo's `card/` directory while it was being
built). Same vanilla-JS, no-build pattern as sb-entity-browser / sb-nav-select /
sb-param-card.

| | |
|---|---|
| Repo | github.com/snadboy/sb-scheduler-card — local `~/projects/git/sb-scheduler-card` |
| Card | `custom:sb-scheduler-card` + `sb-scheduler-card-editor` |
| File | `dist/sb-scheduler-card.js` — vanilla JS, no build step |
| HACS | custom repo, category **Dashboard** |
| Licence | **MIT**, matching the other sb-* cards. It is original code — it talks to the integration only through service calls and entity attributes, and contains nothing from nielsfaber's card. (It was previously published inside the GPL-3 `sb-scheduler` repo; copies taken from there carry GPL-3 terms, which is a non-issue in practice.) |
| Pairs with | the `sb_scheduler` integration — GPL-3, separate repo |

## Why it needs no websocket API

Schedules are read from their `switch` entities' attributes (`schedule_id`,
`day_set`, `pattern`, `times_detail`, `last_triggered`, `next_trigger`) and
day-sets from the `calendar` entities carrying `day_set_id`. Writes go through
`sb_scheduler.edit_schedule`. That is why v1 arrived in one pass: the only
backend change it ever needed was exposing the RAW `pattern` (`times` is the
resolved expansion — editing that would lose an interval).

## Design decisions worth keeping

- **Occurrences are edited as STRUCTURE, never as text.** A row is a Time↔Sun
  slider plus either a time picker, or {event dropdown, +/− dropdown, minutes
  spinner}. `parseOccurrence` / `serialiseOccurrence` convert to and from the
  stored string. This removed a whole bug class rather than patching it — see
  below.
- **Never re-render while the editor is open.** `set hass` returns early when
  `this._open` is set, or a state update mid-typing discards the draft. The
  draft is local state, never read back from hass.
- **A resolved time hides its source**, so the card renders
  `6:51 (after sunrise)` from `times_detail`. It cannot zip `times` against the
  stored occurrences — resolution sorts by clock time and reorders them.
- Plain `<input>`, not `ha-textfield`: that renders invisible outside `ha-form`.
  Native `<select>` needs explicit `option` colours plus `color-scheme: light
  dark` or its popup ignores the theme.
- Rows use `flex-wrap` with `.info { flex: 1 1 180px }` so the three controls
  drop to a second line on a phone instead of crushing the text.

## The bug that shaped the editor

v0.5.1 chose `type=time` vs `type=text` from `isSun(value)`. A typo
(`sccunrise-00:15`) stopped matching, so the row re-rendered as a time picker,
which **refuses to display non-time text** — the value went invisible and
unreachable, and `sunset+` could not be typed at all. v0.6.0 made it
recoverable with a sticky per-row kind; v0.7.0 made it impossible by removing
free text entirely. Prefer removing a bug class to catching it.

## Steps (v0.8.0, 2026-09-20)

A schedule holds one or more **steps** (pattern + actions). The card reads
`steps[]` off the switch entity; the top-level `pattern`/`times_detail` it used
before no longer exist.

- **Every schedule renders its steps on the rail**, one step or ten, each with
  its own times, Last/Next, enable toggle and Run now (v0.9.2). Until then a
  one-step schedule was flattened into the header to avoid repeating its only
  step's name — but that hid the step name entirely and made a schedule's shape
  depend on how many steps it happened to have. The schedule-level Run now went
  with it: for a one-step schedule the step's own button is the same thing.
- The editor gives each step its own bordered block. **Steps cannot be added or
  removed here**, because a step with no actions does nothing and actions are
  not editable in v1.
- **Save sends only `{step_id, name, enabled, pattern}`.** The backend merges
  by `step_id` (`merge_steps`), so the actions the card cannot edit survive.
  Before that merge existed, this same save would have emptied them.
- **The step toggle must send every `step_id`** — the stored list becomes
  exactly what was passed, so an omitted step is deleted.
- `.step .info` wraps at 110px, not the schedule's 180px: a step sits inside an
  already-indented row, and at sidebar width its controls otherwise spill onto
  a second line.

## Full editing (v0.9.0, 2026-09-20)

Create, delete, add/remove steps, and edit ACTIONS. The card now writes through
all three services (`create_schedule`, `edit_schedule`, `remove_schedule`).

- **Actions are entity-first.** Pick an entity (filter box + capped select — a
  select of 9,000 entities is unusable), and the service list comes from
  `hass.services[domain]`, so no service name is ever typed. A second mode,
  **Service only**, exists for actions with no target: `notify.mobile_app_*` is
  a service, not an entity, and entity-first alone cannot express it.
- **Unknown and nested service_data is preserved, never re-parsed.** The Bins
  Out action carries `data: {tag, channel}`; the tag is what makes the
  notification replace in place. Objects and arrays render read-only. Editing
  the message must not silently drop the tag.
- **`brightness: 3` is not in `light.turn_on`'s documented fields** (2026.9
  buries it under `additional_fields`), so the editor renders a row for every
  key already present in `service_data`, and only uses the service metadata to
  populate "+ Add a field". Rendering only documented fields would have made
  the bedside lamps' brightness invisible and then dropped it.
- Field editors come from the selector: number/boolean/text. Anything else is
  preserved and shown read-only.
- **Removing a step is draft-local**, so Cancel undoes it — no confirmation.
  Deleting a SCHEDULE is immediate, so that one has an inline confirm.
- A step with no actions fails validation: it would arm a timer that does
  nothing.
- New steps are saved with **no `step_id`** so the backend allocates one; see
  `allocate_step_ids` in the integration for why positional ids collide.

## One clock format (v0.9.4)

Every clock time the card renders goes through `clock12` — 12-hour with AM/PM,
**not** locale-dependent. Before this the card mixed three sources:
`summarise` emitted 24-hour (`19:10`), `prettyTrigger` used the browser locale
(`07:10 PM` here, 24-hour elsewhere), and `<input type="time">` follows the OS.
So one row could read `19:10` on the times line and `07:10 PM` on Next.

`prettyTrigger` now passes `hour12: true` explicitly rather than trusting the
locale, so the two can't drift apart on a differently configured browser.

Midnight and noon are the cases to check on any change here: `00:00` must be
`12:00 AM` and `12:00` must be `12:00 PM` (`h % 12 || 12`).

**`<input type="time">` cannot be controlled** — the browser renders it from
the OS locale. It shows AM/PM on this setup; on a 24-hour locale the editor's
pickers would disagree with the rest of the card, and the only fix would be
replacing them with custom controls.

## Day-sets live in a modal dialog (v0.11.0)

v0.10.0 listed nine day-sets under the schedules and the main card became a
wall — user: "much too cluttered". Day-sets now open from one **Day-sets…**
button into a native `<dialog>` shown with `showModal()`. That puts it in the
browser's **top layer**, so it overlays the whole page from inside this
shadow root with no HA dialog machinery (`ha-dialog` is internal and
`browser_mod` would be a dependency). List and editor swap inside the same
dialog; Cancel returns to the list, Escape / ✕ / a backdrop click close it.

- `_render()` rebuilds `innerHTML`, which destroys the `<dialog>`, so every
  render re-creates it and calls `showModal()` again if `_dsDialog` is set.
  A re-render while the LIST is showing is wanted (the roster refreshes after
  a save); while the EDITOR is showing, `set hass` still returns early.
- Escape fires the dialog's `close` event → `_dsClose()`. A backdrop click is
  a click whose target is the `<dialog>` element itself (not its body).
- The dialog is styled with `--card-background-color` / `--primary-text-color`
  and a translucent `::backdrop`; `color-scheme: light dark` on `:host` keeps
  native controls themed inside it.
- Verified headless: `dialog:modal` matches while open (proves top layer).

## Day-set editing in the card (v0.10.0)

The card now creates, edits and deletes day-sets — "one visual place for every
time-based rule" finally means one place. Read path: the roster sensor's
`config` (the stored dict, verbatim) and `used_by`. Write path:
`sb_scheduler.set_day_set` (no `id` = create, `id` = update) and
`remove_day_set`. The backend validates with the SAME function the Configure
form uses, so the card can only ever show the errors the form would.

- **Errors arrive as `service_validation_error` over the WebSocket** with the
  message text — that is what `hass.callService` rejects with, so
  `err.message` is shown as-is. (HA's REST `/api/services` endpoint lets the
  same exception escape as a 500 — irrelevant to the card, but it will fool a
  curl-based test.)
- **Delete is refused server-side while anything depends on the set**, and
  the card knows in advance: `used_by` drives an "In use by …" note in place
  of the Delete button. Never trust only the client-side check.
- Sections are native `<details>`, open when they hold a value — same rule as
  the Configure form. Weekdays and months are chip toggles, calendars are a
  filterable checkbox list that EXCLUDES this integration's own calendar
  entities (building on those is what "Built on" is for).
- Dates are the one free-text field, by nature (ranges). A loose regex checks
  the shape client-side; the server is the real validator.
- **A save reloads the config entry**, so the roster sensor vanishes for a
  couple of seconds and comes back — the list empties and refills. Tests must
  wait ~10 s after a save before reading the roster.
- **Test harness: poll until mounted.** A fixed wait after navigation raced
  the dashboard and produced a false "card never mounted" — the module had
  loaded, the view just had not rendered cards yet. Poll for a `.row` inside
  the shadow root instead.
- Editing a day-set from the card is `_dsOpen`/`_dsDraft`, parallel to the
  schedule editor's `_open`/`_draft`; `set hass` returns early for both.

## Day-sets come from the roster sensor (v0.9.5)

`_daySets()` reads `sensor.sb_scheduler_day_sets` — the entity carrying
`roster: sb_scheduler` and a `day_sets: [{id, name, calendar, …}]` attribute —
and falls back to scanning `calendar.*` for `day_set_id` only when no roster
exists (integration < 0.3.0). Reason: a derived day-set ("every other
Tuesday", "Election Day") can now opt OUT of a calendar entity, and the old
calendar scan would simply not list it, so it could never be chosen in
Runs-on. Requires sb_scheduler ≥ 0.3.0 for the roster; keep the attribute
shape in step with `sensor.py` there.

## Collapsible rows (v0.9.3)

Each schedule's steps fold up behind a disclosure triangle. **The disclosure
carries the summary** — one step shows its time, several show the count — so a
folded row still says when it runs; a bare triangle would have hidden that.

Default is EXPANDED. Collapsing by default would have hidden Last/Next, which
is information the user specifically asked to have on the row.

The collapsed set lives in `localStorage` under `sb-scheduler-card.collapsed`.
That is the right home for a per-viewer convenience, but both read and write
are wrapped in try/catch — it throws in a private window or with site data
blocked — and the in-memory `Set` is the truth, so the card renders correctly
with no storage at all.

## Check for duplicate Lovelace resources after a HACS update

After `ha_manage_hacs` downloaded v0.8.0, Lovelace had **two** resources:
`sb-scheduler-card.js?hacstag=…070` and `…080`. The browser loaded the module
twice and the second `customElements.define` threw
`the name "sb-scheduler-card" has already been used`. Both URLs point at the
same file so behaviour was still correct, but a browser holding the old URL
would serve stale code.

The v0.8.0 → v0.9.0 download then updated the single resource **in place**, so
this is not "HACS always duplicates" — the stray was most likely the original
hand-added resource sitting alongside the HACS-managed one. Still worth a check
after an update, because the symptom is only a console error:

```
lovelace/resources        -> find duplicates
lovelace/resources/delete { "resource_id": "..." }
```

## Testing

`parseOccurrence`/`serialiseOccurrence` round-trips can be checked without a
browser by slicing them out of the bundle:

```bash
node -e 'const fs=require("fs");const src=fs.readFileSync("dist/sb-scheduler-card.js","utf8");
const body=src.slice(src.indexOf("const SUN ="), src.indexOf("const esc ="));
fs.writeFileSync("/tmp/occ.cjs", body+"\nmodule.exports={parseOccurrence,serialiseOccurrence};");
const {parseOccurrence,serialiseOccurrence}=require("/tmp/occ.cjs");
console.log(serialiseOccurrence(parseOccurrence("sunset+00:15:00")));'
```

For the UI itself, drive it headlessly with playwright-core (chromium under
`~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`) and reach into the
shadow root — the card's contents are not in the light DOM.

**Test against a throwaway schedule, not a live one.** Several checks during
development edited real schedules and had to be reverted.
