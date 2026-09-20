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

- A **one-step schedule renders flat** — repeating its only step's name under
  the schedule's own name is noise. Multi-step schedules get a line per step on
  an indented rail, each with its own times, Last/Next, enable toggle and
  Run now.
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
