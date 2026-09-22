# SB Scheduler Card

A Lovelace card for editing [**sb_scheduler**](https://github.com/snadboy/sb-scheduler)
schedules — which days a schedule runs on, and what times within a day.

<!-- screenshot goes here -->

## What it does

Lists every schedule with its day type, times, last run and next run, and lets
you edit the name, the day type and the time pattern.

| Control | |
|---|---|
| **Toggle** | enable / disable the schedule |
| **Run now** | fire its actions immediately, ignoring the day type |
| **Edit** | name, day type and times |

Times are never typed. A row is a **Time ↔ Sun** slider plus either a time
picker, or an event dropdown (Sunrise / Sunset), a `+`/`−` dropdown and a
minutes spinner. `sunset+00:15` is assembled, not spelled — so it cannot be
misspelled.

Sun-relative times show what they track: `6:51 (after sunrise)`.

## What it does NOT do (yet)

- **Create** schedules — use the `sb_scheduler.create_schedule` action
- **Edit actions** — use `sb_scheduler.edit_schedule`
- **Delete** schedules — use `sb_scheduler.remove_schedule`

Creating and action-editing are most of the work in a scheduler card; leaving
them out got a usable editor sooner. They may arrive later.

## Requirements

The [`sb_scheduler`](https://github.com/snadboy/sb-scheduler) integration. The
card needs no websocket API of its own: it reads schedules from their `switch`
entities and day types from the `calendar` entities the integration publishes,
and writes through `sb_scheduler.edit_schedule`.

## Install

HACS → three dots → **Custom repositories** → add
`https://github.com/snadboy/sb-scheduler-card` with category **Dashboard**,
then download it. Add the card to a view:

```yaml
type: custom:sb-scheduler-card
title: Schedules
```

`title` is the only option.

## License

MIT.
