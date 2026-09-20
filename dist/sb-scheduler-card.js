/* SB Scheduler Card — v0.8.0 (edit-only, steps-aware)
 *
 * Edits existing sb_scheduler schedules: name, day-set, and each step's name
 * and time pattern. A schedule holds one or more STEPS — "Garden Lights" is one
 * schedule with an On step at sunset and an Off step at sunrise — so times and
 * next/last are per step, not per schedule.
 *
 * Creating schedules and editing ACTIONS are deliberately out of v1, which is
 * also why steps cannot be added here: a step with no actions does nothing.
 *
 * Needs no websocket API: schedules are read from their switch entities'
 * attributes and written back through `sb_scheduler.edit_schedule`.
 */

const CARD = "sb-scheduler-card";
const VERSION = "0.8.0";

// "sunset", "sunset+00:15:00", "sunrise-01:30" — must survive a round-trip
// through the editor.
const SUN = /^(sunrise|sunset)(\s*[+-]\s*\d{1,2}:\d{2}(:\d{2})?)?$/i;

// An occurrence is EDITED as structure, never as text: a typo like
// "sccunrise-00:15" cannot be expressed by a toggle, two dropdowns and a
// spinner. Parsed on open, serialised on save.
const parseOccurrence = (raw) => {
  const s = String(raw ?? "").trim();
  const m = SUN.exec(s);
  if (m) {
    let sign = "+", minutes = 0;
    if (m[2]) {
      const off = m[2].replace(/\s/g, "");
      sign = off[0] === "-" ? "-" : "+";
      const [h, mi] = off.slice(1).split(":").map(Number);
      minutes = (h || 0) * 60 + (mi || 0);
    }
    return { kind: "sun", event: m[1].toLowerCase(), sign, minutes, time: "06:30" };
  }
  const clock = /^(\d{1,2}):(\d{2})/.exec(s);
  return {
    kind: "clock",
    time: clock ? `${String(clock[1]).padStart(2, "0")}:${clock[2]}` : "06:30",
    event: "sunset", sign: "+", minutes: 0,
  };
};

const serialiseOccurrence = (o) => {
  if (o.kind !== "sun") return o.time;
  const n = Math.max(0, Math.round(Number(o.minutes) || 0));
  if (!n) return o.event;               // "sunset" — a bare event means no offset
  const h = String(Math.floor(n / 60)).padStart(2, "0");
  const m = String(n % 60).padStart(2, "0");
  return `${o.event}${o.sign}${h}:${m}:00`;
};

// "06:50" -> "6:50"; a schedule time is read, not sorted, so drop the pad.
const hhmm = (t) => String(t ?? "").replace(/^0/, "");

// "6:50 (after sunrise)" — a resolved clock time alone hides the fact that it
// tracks the sun and will be different tomorrow. The offset magnitude is
// deliberately not shown; the resolved time already says when it fires.
const describeTime = (d) => {
  const clock = hhmm(d.time);
  if (!d.event) return clock;
  const mins = Number(d.offset_minutes || 0);
  const when = mins === 0 ? "at" : mins > 0 ? "after" : "before";
  return `${clock} (${when} ${d.event})`;
};

// One step's times, however its pattern is shaped.
const summarise = (step) => {
  const pattern = step.pattern || {};
  if (pattern.type === "interval") {
    return `every ${pattern.every_minutes} min, ` +
      `${hhmm(String(pattern.start).slice(0, 5))}–${hhmm(String(pattern.stop).slice(0, 5))}`;
  }
  return (step.times_detail
    ? step.times_detail.map(describeTime)
    : (step.times || []).map((t) => hhmm(String(t).slice(0, 5)))
  ).join(", ");
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "2026-09-21T06:30:00-05:00" -> "Mon 21 Sep, 06:30"
const prettyTrigger = (iso) => {
  if (!iso) return "not scheduled";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
};

class SbSchedulerCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(`${CARD}-editor`);
  }
  static getStubConfig() {
    return { title: "Schedules" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._open = null;   // schedule_id being edited
    this._draft = null;  // local edit state; NEVER overwritten from hass
    this._sig = null;
  }

  setConfig(config) {
    this._config = { title: "Schedules", ...(config || {}) };
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // While the editor is open, re-rendering would discard half-typed input.
    if (this._open) return;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  getCardSize() {
    return 3 + this._schedules().reduce((n, s) => n + this._steps(s).length, 0);
  }

  // --- data ---------------------------------------------------------------
  _schedules() {
    const states = this._hass?.states || {};
    return Object.keys(states)
      .filter((id) => id.startsWith("switch.") && states[id].attributes?.schedule_id)
      .map((id) => ({ entity_id: id, ...states[id].attributes, state: states[id].state }))
      .sort((a, b) => String(a.friendly_name).localeCompare(String(b.friendly_name)));
  }

  _steps(s) {
    return Array.isArray(s.steps) ? s.steps : [];
  }

  _daySets() {
    const states = this._hass?.states || {};
    return Object.keys(states)
      .filter((id) => id.startsWith("calendar.") && states[id].attributes?.day_set_id)
      .map((id) => ({
        id: states[id].attributes.day_set_id,
        name: states[id].attributes.friendly_name || states[id].attributes.day_set_id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _signature() {
    return this._schedules()
      .map((s) => `${s.schedule_id}|${s.state}|${s.day_set}|${s.friendly_name}|` +
        this._steps(s).map((t) =>
          `${t.step_id}:${t.name}:${t.enabled}:${t.next_trigger}:${t.last_triggered}:${JSON.stringify(t.pattern)}`
        ).join(";"))
      .join("~");
  }

  // --- editing ------------------------------------------------------------
  _beginEdit(scheduleId) {
    const s = this._schedules().find((x) => x.schedule_id === scheduleId);
    if (!s) return;
    this._open = scheduleId;
    this._draft = {
      entity_id: s.entity_id,
      name: s.friendly_name || "",
      day_set: s.day_set || "daily",
      steps: this._steps(s).map((step) => {
        const pattern = step.pattern || {};
        const occurrences = (pattern.occurrences || []).map(parseOccurrence);
        return {
          step_id: step.step_id,
          name: step.name || "",
          enabled: step.enabled !== false,
          type: pattern.type === "interval" ? "interval" : "occurrences",
          occurrences: occurrences.length ? occurrences : [parseOccurrence("06:30")],
          start: String(pattern.start || "09:00").slice(0, 5),
          stop: String(pattern.stop || "17:00").slice(0, 5),
          every_minutes: Number(pattern.every_minutes || 15),
        };
      }),
      error: null,
    };
    this._render();
  }

  _cancel() {
    this._open = null;
    this._draft = null;
    this._sig = null;
    this._render();
  }

  _validate(d) {
    const timeOk = (t) => /^\d{1,2}:\d{2}$/.test(t) &&
      Number(t.split(":")[0]) < 24 && Number(t.split(":")[1]) < 60;
    if (!d.name.trim()) return "Name cannot be empty.";
    for (const step of d.steps) {
      const where = d.steps.length > 1 ? `"${step.name || "step"}": ` : "";
      if (!step.name.trim()) return "Every step needs a name.";
      if (step.type === "occurrences") {
        if (!step.occurrences.length) return `${where}add at least one time.`;
        // Every value is assembled from a toggle, dropdowns and a spinner, so
        // it cannot be misspelled. Only a clock row can still be blank.
        if (step.occurrences.some((o) => o.kind === "clock" && !timeOk(o.time))) {
          return `${where}every clock time needs a value.`;
        }
      } else {
        if (!timeOk(step.start) || !timeOk(step.stop)) {
          return `${where}start and stop must be times.`;
        }
        if (step.stop <= step.start) return `${where}stop must be after start.`;
        if (!(step.every_minutes >= 1)) {
          return `${where}repeat every … must be at least 1 minute.`;
        }
      }
    }
    return null;
  }

  async _save() {
    const d = this._draft;
    const error = this._validate(d);
    if (error) {
      d.error = error;
      this._render();
      return;
    }
    try {
      await this._hass.callService("sb_scheduler", "edit_schedule", {
        schedule_id: this._open,
        name: d.name.trim(),
        day_set: d.day_set,
        // Only what this card owns. The backend merges each step onto the
        // stored one by step_id, so the actions it cannot edit are preserved.
        steps: d.steps.map((step) => ({
          step_id: step.step_id,
          name: step.name.trim(),
          enabled: step.enabled,
          pattern: step.type === "interval"
            ? { type: "interval", start: step.start, stop: step.stop,
                every_minutes: Number(step.every_minutes) }
            : { type: "occurrences",
                occurrences: step.occurrences.map(serialiseOccurrence) },
        })),
      });
      this._cancel();
    } catch (err) {
      d.error = `Save failed: ${err?.message || err}`;
      this._render();
    }
  }

  /** Flip one step's enabled flag.
   *
   * There is no per-step service, so this goes through edit_schedule — and it
   * must send EVERY step, because an omitted step is a deletion.
   */
  _toggleStep(scheduleId, stepId, enabled) {
    const s = this._schedules().find((x) => x.schedule_id === scheduleId);
    if (!s) return;
    this._hass.callService("sb_scheduler", "edit_schedule", {
      schedule_id: scheduleId,
      steps: this._steps(s).map((step) => ({
        step_id: step.step_id,
        enabled: step.step_id === stepId ? enabled : step.enabled !== false,
      })),
    });
  }

  // --- rendering ----------------------------------------------------------
  _render() {
    if (!this.shadowRoot) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = "";
      return;
    }
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${
      this._config.title ? `<h1 class="card-header">${esc(this._config.title)}</h1>` : ""
    }<div class="body">${this._open ? this._editorHtml() : this._listHtml()}</div></ha-card>`;
    this._wire();
  }

  _listHtml() {
    const rows = this._schedules();
    if (!rows.length) {
      return `<div class="empty">No schedules yet.<br>
        Create one with the <code>sb_scheduler.create_schedule</code> action —
        this card edits existing schedules.</div>`;
    }
    return rows.map((s) => {
      const steps = this._steps(s);
      const on = s.state !== "off";
      // A one-step schedule is shown flat: repeating its only step's name
      // under its own is noise. Multi-step schedules get a line each.
      const solo = steps.length === 1 ? steps[0] : null;
      return `<div class="row ${on ? "" : "disabled"}">
        <div class="head">
          <div class="info">
            <div class="name">${esc(s.friendly_name)}</div>
            <div class="meta">
              <span class="chip">${esc(s.day_set)}</span>
              ${solo ? `<span>${esc(summarise(solo))}</span>` : `<span>${steps.length} steps</span>`}
            </div>
            ${solo ? `
              <div class="sub">Last: ${esc(solo.last_triggered ? prettyTrigger(solo.last_triggered) : "never")}</div>
              <div class="sub">Next: ${on ? esc(prettyTrigger(solo.next_trigger)) : "—"}</div>` : ""}
          </div>
          <div class="controls">
            <label class="toggle" title="${on ? "Disable" : "Enable"} this schedule">
              <input type="checkbox" class="enable" data-entity="${esc(s.entity_id)}" ${on ? "checked" : ""}>
              <span></span>
            </label>
            ${solo ? `<button class="run" data-entity="${esc(s.entity_id)}"
                       title="Run the actions now, ignoring the day-set">Run now</button>` : ""}
            <button class="edit" data-id="${esc(s.schedule_id)}">Edit</button>
          </div>
        </div>
        ${solo ? "" : `<div class="steps">${steps.map((step) => {
          const stepOn = step.enabled !== false;
          return `<div class="step ${stepOn && on ? "" : "disabled"}">
            <div class="info">
              <div class="sname">${esc(step.name)}
                <span class="stimes">${esc(summarise(step))}</span></div>
              <div class="sub">Last: ${esc(step.last_triggered ? prettyTrigger(step.last_triggered) : "never")}</div>
              <div class="sub">Next: ${on && stepOn ? esc(prettyTrigger(step.next_trigger)) : "—"}</div>
            </div>
            <div class="controls">
              <label class="toggle small" title="${stepOn ? "Disable" : "Enable"} this step">
                <input type="checkbox" class="step-enable" data-id="${esc(s.schedule_id)}"
                       data-step="${esc(step.step_id)}" ${stepOn ? "checked" : ""}>
                <span></span>
              </label>
              <button class="run" data-entity="${esc(s.entity_id)}" data-step="${esc(step.step_id)}"
                      title="Run this step's actions now, ignoring the day-set">Run now</button>
            </div>
          </div>`;
        }).join("")}</div>`}
      </div>`;
    }).join("");
  }

  _editorHtml() {
    const d = this._draft;
    const daySets = this._daySets();
    const known = daySets.some((x) => x.id === d.day_set);
    return `
      ${d.error ? `<div class="error">${esc(d.error)}</div>` : ""}
      <label class="field"><span>Name</span>
        <input id="name" type="text" value="${esc(d.name)}"></label>

      <label class="field"><span>Runs on</span>
        <select id="day_set">
          ${daySets.map((x) => `<option value="${esc(x.id)}" ${x.id === d.day_set ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
          ${known ? "" : `<option value="${esc(d.day_set)}" selected>${esc(d.day_set)} (missing)</option>`}
        </select></label>
      ${known ? "" : `<div class="warn">This schedule points at a day-set that no longer exists, so it cannot run.</div>`}

      ${d.steps.map((step, si) => this._stepHtml(step, si, d.steps.length)).join("")}

      <div class="actions-note">Actions are not editable here in v1 — use
        <code>sb_scheduler.edit_schedule</code>. Adding a step needs actions,
        so it belongs there too.</div>

      <div class="buttons">
        <button class="cancel">Cancel</button>
        <button class="save">Save</button>
      </div>`;
  }

  _stepHtml(step, si, total) {
    return `
      <div class="stepedit ${step.enabled ? "" : "off"}">
        ${total > 1 ? `
          <div class="stephead">
            <input class="step-name" data-s="${si}" type="text" value="${esc(step.name)}"
                   placeholder="Step name">
            <label class="toggle small" title="${step.enabled ? "Disable" : "Enable"} this step">
              <input type="checkbox" class="step-on" data-s="${si}" ${step.enabled ? "checked" : ""}>
              <span></span>
            </label>
          </div>` : `
          <input class="step-name" data-s="${si}" type="hidden" value="${esc(step.name)}">`}

        <div class="field"><span>Times</span>
          <div class="radios">
            <label><input type="radio" name="ptype${si}" data-s="${si}" value="occurrences"
              ${step.type === "occurrences" ? "checked" : ""}> At set times</label>
            <label><input type="radio" name="ptype${si}" data-s="${si}" value="interval"
              ${step.type === "interval" ? "checked" : ""}> Every N minutes</label>
          </div>
        </div>

        ${step.type === "occurrences" ? `
          <div class="times">
            ${step.occurrences.map((o, i) => `
              <div class="timerow">
                <span class="modelbl ${o.kind === "clock" ? "on" : ""}">Time</span>
                <label class="toggle" title="Switch between a clock time and a sun-relative one">
                  <input type="checkbox" class="mode" data-s="${si}" data-i="${i}" ${o.kind === "sun" ? "checked" : ""}>
                  <span></span>
                </label>
                <span class="modelbl ${o.kind === "sun" ? "on" : ""}">Sun</span>
                ${o.kind === "clock" ? `
                  <input class="occ-time" data-s="${si}" data-i="${i}" type="time" value="${esc(o.time)}">
                ` : `
                  <select class="occ-event" data-s="${si}" data-i="${i}">
                    <option value="sunrise" ${o.event === "sunrise" ? "selected" : ""}>Sunrise</option>
                    <option value="sunset" ${o.event === "sunset" ? "selected" : ""}>Sunset</option>
                  </select>
                  <select class="occ-sign" data-s="${si}" data-i="${i}">
                    <option value="+" ${o.sign === "+" ? "selected" : ""}>+</option>
                    <option value="-" ${o.sign === "-" ? "selected" : ""}>−</option>
                  </select>
                  <input class="occ-mins" data-s="${si}" data-i="${i}" type="number" min="0" max="720" step="5"
                         value="${esc(o.minutes)}">
                  <span class="unit">min</span>
                `}
                ${step.occurrences.length > 1 ? `<button class="drop" data-s="${si}" data-i="${i}" title="Remove">✕</button>` : ""}
              </div>`).join("")}
            <button class="add" data-s="${si}">+ Add a time</button>
          </div>` : `
          <div class="interval">
            <label class="field inline"><span>From</span>
              <input class="iv-start" data-s="${si}" type="time" value="${esc(step.start)}"></label>
            <label class="field inline"><span>Until</span>
              <input class="iv-stop" data-s="${si}" type="time" value="${esc(step.stop)}"></label>
            <label class="field inline"><span>Every (min)</span>
              <input class="iv-every" data-s="${si}" type="number" min="1" max="720" value="${esc(step.every_minutes)}"></label>
            <div class="count" data-s="${si}">${this._intervalCount(step)}</div>
          </div>`}
      </div>`;
  }

  _intervalCount(step) {
    const toMin = (t) => {
      const [h, m] = String(t).split(":").map(Number);
      return h * 60 + m;
    };
    const span = toMin(step.stop) - toMin(step.start);
    const size = Number(step.every_minutes);
    if (!(span >= 0) || !(size >= 1)) return "";
    const n = Math.floor(span / size) + 1;
    return `${n} firing${n === 1 ? "" : "s"} per day`;
  }

  _wire() {
    const root = this.shadowRoot;
    root.querySelectorAll("button.edit").forEach((b) =>
      b.addEventListener("click", () => this._beginEdit(b.dataset.id)));

    // Run now fires the actions immediately, ignoring the day-set. No confirm
    // step: the button is explicit and the consequence is one run of something
    // the schedule does anyway. The Last: line updating is the receipt.
    root.querySelectorAll("button.run").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "Running…";
        try {
          const data = { entity_id: b.dataset.entity };
          if (b.dataset.step) data.step_id = b.dataset.step;
          await this._hass.callService("sb_scheduler", "run_now", data);
        } catch (err) {
          b.textContent = "Failed";
          b.title = String(err?.message || err);
          return;
        }
        // last_triggered changes, which re-renders the list and restores this
        // button. Restore by hand too, in case the service was a no-op.
        setTimeout(() => {
          b.disabled = false;
          b.textContent = "Run now";
        }, 1500);
      }));

    root.querySelectorAll("input.enable").forEach((box) =>
      box.addEventListener("change", () => {
        this._hass.callService("switch", box.checked ? "turn_on" : "turn_off", {
          entity_id: box.dataset.entity,
        });
      }));

    root.querySelectorAll("input.step-enable").forEach((box) =>
      box.addEventListener("change", () =>
        this._toggleStep(box.dataset.id, box.dataset.step, box.checked)));

    if (!this._open) return;
    const d = this._draft;
    const stepOf = (el) => d.steps[Number(el.dataset.s)];

    const name = root.querySelector("#name");
    if (name) name.addEventListener("input", () => { d.name = name.value; });
    const daySet = root.querySelector("#day_set");
    if (daySet) daySet.addEventListener("change", () => { d.day_set = daySet.value; });

    const onStep = (sel, apply, evt = "input") =>
      root.querySelectorAll(sel).forEach((el) =>
        el.addEventListener(evt, () => { apply(stepOf(el), el); d.error = null; }));

    onStep("input.step-name", (step, el) => { step.name = el.value; });
    onStep("input.iv-start", (step, el) => { step.start = el.value; });
    onStep("input.iv-stop", (step, el) => { step.stop = el.value; });
    onStep("input.iv-every", (step, el) => { step.every_minutes = Number(el.value); });

    root.querySelectorAll("input.step-on").forEach((box) =>
      box.addEventListener("change", () => {
        stepOf(box).enabled = box.checked;
        this._render();
      }));

    root.querySelectorAll('input[type="radio"][data-s]').forEach((r) =>
      r.addEventListener("change", () => {
        if (!r.checked) return;
        stepOf(r).type = r.value;
        d.error = null;
        this._render();
      }));

    const onOcc = (sel, apply, evt = "input") =>
      root.querySelectorAll(sel).forEach((el) =>
        el.addEventListener(evt, () => {
          apply(stepOf(el).occurrences[Number(el.dataset.i)], el);
          d.error = null;
        }));

    onOcc("input.occ-time", (o, el) => { o.time = el.value; });
    onOcc("select.occ-event", (o, el) => { o.event = el.value; }, "change");
    onOcc("select.occ-sign", (o, el) => { o.sign = el.value; }, "change");
    onOcc("input.occ-mins", (o, el) => {
      o.minutes = Math.max(0, Math.min(720, Math.round(Number(el.value) || 0)));
    });

    root.querySelectorAll("input.mode").forEach((box) =>
      box.addEventListener("change", () => {
        const o = stepOf(box).occurrences[Number(box.dataset.i)];
        o.kind = box.checked ? "sun" : "clock";
        d.error = null;
        this._render();
      }));

    root.querySelectorAll("button.drop").forEach((b) =>
      b.addEventListener("click", () => {
        stepOf(b).occurrences.splice(Number(b.dataset.i), 1);
        this._render();
      }));

    root.querySelectorAll("button.add").forEach((b) =>
      b.addEventListener("click", () => {
        stepOf(b).occurrences.push(parseOccurrence("12:00"));
        this._render();
      }));

    // Live firing count while an interval is being edited.
    root.querySelectorAll("input.iv-start, input.iv-stop, input.iv-every").forEach((el) =>
      el.addEventListener("input", () => {
        const out = root.querySelector(`.count[data-s="${el.dataset.s}"]`);
        if (out) out.textContent = this._intervalCount(stepOf(el));
      }));

    root.querySelector("button.cancel")?.addEventListener("click", () => this._cancel());
    root.querySelector("button.save")?.addEventListener("click", () => this._save());
  }
}

const STYLE = `
:host { display: block; }
/* Native select popups ignore the page theme unless told otherwise. */
:host { color-scheme: light dark; }
.card-header { font-size: 1.25rem; padding: 12px 16px 0; margin: 0; }
.body { padding: 8px 16px 16px; }
.empty { color: var(--secondary-text-color); padding: 12px 0; line-height: 1.5; }
.row { padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
.row:last-of-type { border-bottom: none; }
.row.disabled .name, .row.disabled .meta, .row.disabled .steps { opacity: .55; }
.head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
/* min-width keeps the controls from crushing the text before the row wraps */
.info { flex: 1 1 180px; min-width: 180px; }
.name { font-weight: 500; }
.meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        color: var(--secondary-text-color); font-size: .9em; margin-top: 2px; }
.chip { background: var(--primary-color); color: var(--text-primary-color);
        border-radius: 10px; padding: 1px 8px; font-size: .85em; }
.sub { color: var(--secondary-text-color); font-size: .85em; margin-top: 2px; }
/* Steps sit under their schedule, indented and on a rail, so a two-step
   schedule reads as one thing with two parts rather than two schedules. */
.steps { margin: 6px 0 0 8px; padding-left: 12px;
         border-left: 2px solid var(--divider-color); }
.step { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 6px 0; }
/* Steps live inside a schedule row that is already indented, so they wrap at a
   narrower width than the schedule itself — otherwise every step in a
   sidebar-width column spills its controls onto a second line. */
.step .info { flex: 1 1 110px; min-width: 110px; }
.step .controls { gap: 6px; }
.step .controls button { padding: 3px 8px; font-size: .85em; }
.step.disabled .sname, .step.disabled .sub { opacity: .5; }
.sname { font-size: .95em; }
.stimes { color: var(--secondary-text-color); font-size: .9em; margin-left: 8px; }
.controls { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
.controls button { white-space: nowrap; }
.controls button[disabled] { opacity: .6; cursor: default; }
.toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex: 0 0 auto; }
.toggle.small { width: 34px; height: 19px; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle span { position: absolute; inset: 0; cursor: pointer; border-radius: 22px;
               background: var(--disabled-text-color, #9e9e9e); transition: background .2s; }
.toggle span::before { content: ""; position: absolute; width: 16px; height: 16px;
                       left: 3px; top: 3px; border-radius: 50%; background: #fff;
                       transition: transform .2s; }
.toggle.small span::before { width: 13px; height: 13px; }
.toggle input:checked + span { background: var(--primary-color); }
.toggle input:checked + span::before { transform: translateX(18px); }
.toggle.small input:checked + span::before { transform: translateX(15px); }
.toggle input:focus-visible + span { outline: 2px solid var(--primary-color); outline-offset: 2px; }
button { cursor: pointer; border-radius: 6px; border: 1px solid var(--divider-color);
         background: var(--card-background-color); color: var(--primary-text-color);
         padding: 6px 12px; font: inherit; }
button.save { background: var(--primary-color); color: var(--text-primary-color);
              border-color: transparent; }
button.drop { border: none; background: none; color: var(--error-color); padding: 4px 8px; }
.field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
.field > span { color: var(--secondary-text-color); font-size: .85em; }
.field.inline { flex: 1; }
input, select { font: inherit; padding: 8px; border-radius: 6px;
                border: 1px solid var(--divider-color);
                background: var(--card-background-color); color: var(--primary-text-color); }
option { background: var(--card-background-color); color: var(--primary-text-color); }
.radios { display: flex; gap: 16px; flex-wrap: wrap; }
.radios label { display: flex; align-items: center; gap: 6px; }
.times { display: flex; flex-direction: column; gap: 6px; }
.timerow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.interval { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.count { color: var(--secondary-text-color); font-size: .85em; padding-bottom: 10px; }
/* Each step is a card within the editor, or a multi-step schedule becomes an
   undifferentiated wall of time rows. */
.stepedit { border: 1px solid var(--divider-color); border-radius: 8px;
            padding: 4px 12px 12px; margin: 12px 0; }
.stepedit.off { opacity: .6; }
.stephead { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.stephead .step-name { flex: 1; font-weight: 500; }
.modelbl { font-size: .8em; color: var(--secondary-text-color); }
.modelbl.on { color: var(--primary-text-color); font-weight: 500; }
.timerow select { padding: 7px 6px; }
.occ-mins { width: 76px; }
.unit { font-size: .8em; color: var(--secondary-text-color); }
.buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.error { background: var(--error-color); color: var(--text-primary-color);
         padding: 8px 12px; border-radius: 6px; margin-bottom: 8px; }
.warn { color: var(--warning-color); font-size: .85em; margin: -6px 0 8px; }
.actions-note { color: var(--secondary-text-color); font-size: .8em; margin-top: 16px; }
code { background: var(--secondary-background-color); padding: 1px 4px; border-radius: 3px; }
`;

// --- config editor ---------------------------------------------------------
class SbSchedulerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
  }
  _render() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;padding:8px 0">
        <span style="font-size:.85em;color:var(--secondary-text-color)">Title</span>
        <input id="t" type="text" style="font:inherit;padding:8px;border-radius:6px;
          border:1px solid var(--divider-color);background:var(--card-background-color);
          color:var(--primary-text-color)" value="${esc(this._config.title || "")}">
      </div>`;
    this.querySelector("#t").addEventListener("input", (e) => {
      this._config = { ...this._config, title: e.target.value };
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: this._config }, bubbles: true, composed: true,
      }));
    });
  }
}

customElements.define(CARD, SbSchedulerCard);
customElements.define(`${CARD}-editor`, SbSchedulerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD,
  name: "SB Scheduler Card",
  description: "Edit sb_scheduler schedules: day-set and per-step time patterns.",
  preview: false,
  documentationURL: "https://github.com/snadboy/sb-scheduler",
});

console.info(`%c ${CARD.toUpperCase()} %c v${VERSION} `,
  "color:white;background:#3f51b5;font-weight:700",
  "color:#3f51b5;background:white;font-weight:700");
