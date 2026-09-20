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
