/* SB Scheduler Card — v0.12.1
 *
 * A full editor for sb_scheduler schedules: create, delete, and edit name,
 * day-set, steps (add/remove), time patterns and ACTIONS.
 *
 * A schedule holds one or more STEPS — "Garden Lights" is one schedule with an
 * On step at sunset and an Off step at sunrise — so times, actions and
 * next/last are per step, not per schedule.
 *
 * Needs no websocket API: schedules are read from their switch entities'
 * attributes, service metadata from `hass.services`, and everything is written
 * through the sb_scheduler services.
 */

const CARD = "sb-scheduler-card";
const VERSION = "0.12.1";

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

/* --- actions -------------------------------------------------------------
 * Stored shape: { service, entity_id?, service_data }. Three real variants
 * have to round-trip untouched:
 *   light.turn_on  + entity_id + {brightness: 3}
 *   valve.open_valve + entity_id + {}
 *   notify.mobile_app_… + NO entity + {title, message, data: {tag, channel}}
 * The last one is why unknown and nested values are preserved rather than
 * rendered: editing the message must not drop the tag that makes the
 * notification replace in place.
 */
const parseAction = (a) => {
  const [domain, ...rest] = String(a?.service || "").split(".");
  const data = { ...(a?.service_data || {}) };
  const entity = a?.entity_id || data.entity_id || "";
  delete data.entity_id;
  return {
    mode: entity ? "entity" : "service",
    domain: domain || "",
    service: rest.join(".") || "",
    entity_id: entity,
    filter: "",
    data,
  };
};

const serialiseAction = (a) => {
  const out = { service: `${a.domain}.${a.service}`, service_data: { ...a.data } };
  // service_data is ALWAYS written: the action engine subscripts it without
  // checking, so a missing key is a KeyError when the schedule fires.
  if (a.mode === "entity" && a.entity_id) out.entity_id = a.entity_id;
  return out;
};

// Which simple editor a value gets. Anything else is preserved untouched.
const valueKind = (v) => {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "text";
  return "opaque";   // objects and arrays — e.g. notify's data: {tag, channel}
};

// "19:10" -> "7:10 PM". Every clock time the card renders goes through this.
// It does NOT consult the browser locale: prettyTrigger used to and summarise
// did not, so the same row could show "19:10" next to "07:10 PM".
const clock12 = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? "").trim());
  if (!m) return String(t ?? "");
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

// "6:50 (after sunrise)" — a resolved clock time alone hides the fact that it
// tracks the sun and will be different tomorrow. The offset magnitude is
// deliberately not shown; the resolved time already says when it fires.
const describeTime = (d) => {
  const clock = clock12(d.time);
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
      `${clock12(String(pattern.start).slice(0, 5))}–${clock12(String(pattern.stop).slice(0, 5))}`;
  }
  return (step.times_detail
    ? step.times_detail.map(describeTime)
    : (step.times || []).map((t) => clock12(String(t).slice(0, 5)))
  ).join(", ");
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "2026-09-21T06:30:00-05:00" -> "Mon, Sep 21, 6:30 AM"
// hour12 is forced rather than left to the locale, so this matches clock12.
const prettyTrigger = (iso) => {
  if (!iso) return "not scheduled";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
};

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-03" -> "Tue, Nov 3" — a day-set date has no time of day.
const prettyDate = (iso) => {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

// A draft's "have you changed anything" fingerprint. UI-only fields are
// dropped so that typing in a filter box or opening a confirm does not count
// as unsaved work.
const VOLATILE = new Set(["error", "confirmDelete", "confirmDiscard", "calFilter", "usedBy", "filter"]);
const snapshot = (d) => JSON.stringify(d, (k, v) => (VOLATILE.has(k) ? undefined : v));

const blankStep = () => ({
  step_id: null,           // no id — the backend allocates a fresh one
  name: "",
  enabled: true,
  type: "occurrences",
  occurrences: [parseOccurrence("06:30")],
  start: "09:00", stop: "17:00", every_minutes: 15,
  actions: [],
});

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
    this._open = null;   // schedule_id being edited, or "__new__"
    this._draft = null;  // local edit state; NEVER overwritten from hass
    this._dsDialog = null; // null = closed, "list" = the day-set dialog is up
    this._dsOpen = null;   // day-set id being edited inside it, or "__new__"
    this._dsDraft = null;  // same rule: local, never overwritten from hass
    this._sig = null;
    this._collapsed = new Set(this._readCollapsed());
  }

  /* Which rows the viewer has folded up. This is a per-viewer convenience, so
   * localStorage is the right home for it — but it can throw in a private
   * window or with site data blocked, and it must never stop the card
   * rendering. Hence try/catch on both sides and a plain Set as the truth. */
  _readCollapsed() {
    try {
      return JSON.parse(localStorage.getItem("sb-scheduler-card.collapsed") || "[]");
    } catch (err) {
      return [];
    }
  }

  _writeCollapsed() {
    try {
      localStorage.setItem("sb-scheduler-card.collapsed",
        JSON.stringify([...this._collapsed]));
    } catch (err) { /* nothing to do — the Set still holds this session */ }
  }

  setConfig(config) {
    this._config = { title: "Schedules", ...(config || {}) };
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // While an editor is open, re-rendering would discard half-typed input.
    if (this._open || this._dsOpen) return;
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

  /** Every day-set, from the integration's roster sensor.
   *
   * Scanning calendar entities used to be enough, but a derived day-set
   * ("every other Tuesday", "Election Day") can opt out of having a calendar
   * and must still be selectable here. The calendar scan stays as a fallback
   * for an integration older than the roster. */
  _daySets() {
    const states = this._hass?.states || {};
    const roster = Object.values(states).find((s) => s.attributes?.roster === "sb_scheduler");
    if (roster && Array.isArray(roster.attributes.day_sets)) {
      return roster.attributes.day_sets
        .map((d) => ({ id: d.id, name: d.name || d.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return Object.keys(states)
      .filter((id) => id.startsWith("calendar.") && states[id].attributes?.day_set_id)
      .map((id) => ({
        id: states[id].attributes.day_set_id,
        name: states[id].attributes.friendly_name || states[id].attributes.day_set_id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Entities matching a filter, capped — a select of 9,000 options is unusable.
   *  The currently chosen one is always included so it can never go missing. */
  _entityOptions(filter, domain, chosen) {
    const states = this._hass?.states || {};
    const q = String(filter || "").toLowerCase().trim();
    const out = [];
    for (const id of Object.keys(states)) {
      if (domain && !id.startsWith(domain + ".")) continue;
      const name = states[id].attributes?.friendly_name || id;
      if (q && !id.toLowerCase().includes(q) && !String(name).toLowerCase().includes(q)) continue;
      out.push({ id, name });
      if (out.length >= 250) break;
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (chosen && !out.some((e) => e.id === chosen)) {
      out.unshift({ id: chosen, name: states[chosen]?.attributes?.friendly_name || chosen });
    }
    return out;
  }

  _domains() {
    return Object.keys(this._hass?.services || {}).sort();
  }

  _servicesFor(domain) {
    const svcs = this._hass?.services?.[domain] || {};
    const keys = Object.keys(svcs).sort();
    // Float the verbs people actually schedule to the top of the list.
    const first = ["turn_on", "turn_off", "toggle", "open_valve", "close_valve",
                   "open_cover", "close_cover", "lock", "unlock", "press"];
    return keys.sort((a, b) => {
      const ia = first.indexOf(a), ib = first.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
  }

  /** Field names this service documents that the action has not set yet. */
  _spareFields(action) {
    const fields = this._hass?.services?.[action.domain]?.[action.service]?.fields || {};
    return Object.keys(fields)
      .filter((k) => !(k in action.data) && k !== "entity_id" && k !== "advanced_fields"
                     && k !== "additional_fields")
      .sort();
  }

  _fieldMeta(action, key) {
    return this._hass?.services?.[action.domain]?.[action.service]?.fields?.[key] || {};
  }

  /** The full roster entries — config and dependents included — for editing. */
  _roster() {
    const states = this._hass?.states || {};
    const roster = Object.values(states).find((s) => s.attributes?.roster === "sb_scheduler");
    return roster && Array.isArray(roster.attributes.day_sets)
      ? [...roster.attributes.day_sets].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      : [];
  }

  /** Calendars a day-set may read: every calendar.* except the ones this
   *  integration publishes itself — building on those is what base_day_set
   *  is for, and it would be circular through the entity anyway. */
  _calendarOptions() {
    const states = this._hass?.states || {};
    return Object.keys(states)
      .filter((id) => id.startsWith("calendar.") && !states[id].attributes?.day_set_id)
      .map((id) => ({ id, name: states[id].attributes?.friendly_name || id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _signature() {
    const roster = this._roster().map((d) => `${d.id}:${d.next_date}:${JSON.stringify(d.config)}:${JSON.stringify(d.used_by)}`).join(";");
    return roster + "#" + this._schedules()
      .map((s) => `${s.schedule_id}|${s.state}|${s.day_set}|${s.friendly_name}|` +
        this._steps(s).map((t) =>
          `${t.step_id}:${t.name}:${t.enabled}:${t.next_trigger}:${t.last_triggered}` +
          `:${JSON.stringify(t.pattern)}:${JSON.stringify(t.actions)}`
        ).join(";"))
      .join("~");
  }

  // --- editing ------------------------------------------------------------
  _beginEdit(scheduleId) {
    const s = this._schedules().find((x) => x.schedule_id === scheduleId);
    if (!s) return;
    this._dsDialog = null;          // one dialog at a time
    this._open = scheduleId;
    this._draft = {
      creating: false,
      confirmDelete: false,
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
          actions: (step.actions || []).map(parseAction),
        };
      }),
      error: null,
      confirmDiscard: false,
    };
    this._snap = snapshot(this._draft);
    this._render();
  }

  _beginCreate() {
    const daySets = this._daySets();
    this._dsDialog = null;          // one dialog at a time
    this._open = "__new__";
    this._draft = {
      creating: true,
      confirmDelete: false,
      name: "",
      day_set: daySets.some((d) => d.id === "daily") ? "daily" : (daySets[0]?.id || "daily"),
      steps: [{ ...blankStep(), name: "Run" }],
      error: null,
      confirmDiscard: false,
    };
    this._snap = snapshot(this._draft);
    this._render();
  }

  /** Close for real. Only Save and a confirmed Discard call this directly. */
  _cancel() {
    this._open = null;
    this._draft = null;
    this._sig = null;
    this._render();
  }

  /** Cancel / ✕ / Escape all come here: close at once if nothing changed,
   *  otherwise ask. Clicking the backdrop is deliberately NOT a way out —
   *  an editor with a Save button must not vanish because focus wandered. */
  _requestCancel() {
    const d = this._draft;
    if (!d) return;
    if (snapshot(d) === this._snap) { this._cancel(); return; }
    d.confirmDiscard = true;
    this._render();
  }

  _validate(d) {
    const timeOk = (t) => /^\d{1,2}:\d{2}$/.test(t) &&
      Number(t.split(":")[0]) < 24 && Number(t.split(":")[1]) < 60;
    if (!d.name.trim()) return "Name cannot be empty.";
    if (!d.steps.length) return "A schedule needs at least one step.";
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
      // A step with no actions arms a timer that does nothing.
      if (!step.actions.length) return `${where}add at least one action.`;
      for (const a of step.actions) {
        if (!a.domain || !a.service) return `${where}every action needs a service.`;
        if (a.mode === "entity" && !a.entity_id) {
          return `${where}${a.domain}.${a.service} needs an entity.`;
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
    const steps = d.steps.map((step) => {
      const out = {
        name: step.name.trim(),
        enabled: step.enabled,
        pattern: step.type === "interval"
          ? { type: "interval", start: step.start, stop: step.stop,
              every_minutes: Number(step.every_minutes) }
          : { type: "occurrences", occurrences: step.occurrences.map(serialiseOccurrence) },
        actions: step.actions.map(serialiseAction),
      };
      // A new step carries no id, so the backend allocates one that cannot
      // collide with a surviving step's.
      if (step.step_id) out.step_id = step.step_id;
      return out;
    });

    try {
      if (d.creating) {
        await this._hass.callService("sb_scheduler", "create_schedule", {
          name: d.name.trim(), day_set: d.day_set, steps,
        });
      } else {
        await this._hass.callService("sb_scheduler", "edit_schedule", {
          schedule_id: this._open, name: d.name.trim(), day_set: d.day_set, steps,
        });
      }
      this._cancel();
    } catch (err) {
      d.error = `Save failed: ${err?.message || err}`;
      this._render();
    }
  }

  async _delete() {
    try {
      await this._hass.callService("sb_scheduler", "remove_schedule", {
        schedule_id: this._open,
      });
      this._cancel();
    } catch (err) {
      this._draft.error = `Delete failed: ${err?.message || err}`;
      this._draft.confirmDelete = false;
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
    // The window-level scroll lock belongs to the dialog that is about to be
    // torn down; re-installed by _wire() if a dialog is rendered again.
    this._removeScrollLock();
    if (!this._hass) {
      this.shadowRoot.innerHTML = "";
      return;
    }
    // The card body is always the list. Both editors — schedules and
    // day-sets — are modal <dialog>s: showModal() puts them in the browser's
    // top layer, so they overlay the whole page from inside this shadow root
    // with no HA dialog machinery involved, and the card never grows.
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${
      this._config.title ? `<h1 class="card-header">${esc(this._config.title)}</h1>` : ""
    }<div class="body">${this._listHtml()}</div></ha-card>${this._scDialogHtml()}${this._dsDialogHtml()}`;
    this._wire();
    this.shadowRoot.querySelectorAll("dialog").forEach((dlg) => {
      if (!dlg.open) {
        try { dlg.showModal(); } catch (err) { /* already open or detached */ }
      }
    });
  }

  _scDialogHtml() {
    if (!this._open) return "";
    return `<dialog class="scdialog"><div class="dsdialog-body">${this._editorHtml()}</div></dialog>`;
  }

  /** showModal() makes the page inert to clicks, but wheel and touch still
   *  scroll HA's dashboard behind the dialog. Measured in Chrome: a wheel
   *  over the backdrop DOES target the <dialog>, yet a non-passive wheel
   *  listener on the dialog element did not stop the page scrolling. A
   *  capturing listener on window does. So, for as long as a dialog is up:
   *  anything outside the dialog body is swallowed, and inside the body a
   *  wheel is swallowed whenever the body cannot scroll further that way —
   *  nothing ever chains to the page. Touch inside the body is left to
   *  overscroll-behavior: contain, or the body itself could not be scrolled. */
  _guardScroll(dlg) {
    this._removeScrollLock();
    const body = dlg.querySelector(".dsdialog-body");
    const handler = (e) => {
      if (!e.composedPath().includes(body)) { e.preventDefault(); return; }
      if (e.type !== "wheel") return;
      const canScroll = body.scrollHeight > body.clientHeight + 1;
      const atTop = body.scrollTop <= 0;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      if (!canScroll || (e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    };
    window.addEventListener("wheel", handler, { capture: true, passive: false });
    window.addEventListener("touchmove", handler, { capture: true, passive: false });
    this._scrollLock = () => {
      window.removeEventListener("wheel", handler, { capture: true });
      window.removeEventListener("touchmove", handler, { capture: true });
    };
  }

  _removeScrollLock() {
    if (this._scrollLock) { this._scrollLock(); this._scrollLock = null; }
  }

  disconnectedCallback() {
    this._removeScrollLock();
  }

  _dsDialogHtml() {
    if (!this._dsDialog) return "";
    return `<dialog class="dsdialog"><div class="dsdialog-body">${
      this._dsOpen ? this._dsEditorHtml() : this._dsListHtml()
    }</div></dialog>`;
  }

  _dsClose() {
    this._dsDialog = null;
    this._dsOpen = null;
    this._dsDraft = null;
    this._sig = null;
    this._render();
  }

  _listHtml() {
    const rows = this._schedules();
    const add = `<div class="addrow">
      <button class="new">+ New schedule</button>
      <button class="dsopen" title="Create and edit the day-sets schedules run on">Day-sets…</button>
    </div>`;
    if (!rows.length) {
      return `<div class="empty">No schedules yet.</div>${add}`;
    }
    return rows.map((s) => {
      const steps = this._steps(s);
      const on = s.state !== "off";
      // EVERY schedule renders its steps on the rail, one step or ten. The
      // one-step case used to be flattened into the header, which hid the
      // step's name and made a schedule's shape depend on how many steps it
      // happened to have.
      const shut = this._collapsed.has(s.schedule_id);
      // Folded up, the row still has to say WHEN it runs — so the disclosure
      // carries the summary: one step shows its time, several show the count.
      const gist = steps.length === 1
        ? summarise(steps[0])
        : `${steps.length} steps`;
      return `<div class="row ${on ? "" : "disabled"}">
        <div class="head">
          <div class="info">
            <div class="name">${esc(s.friendly_name)}</div>
            <div class="meta">
              <span class="chip">${esc(s.day_set)}</span>
              <button class="disclose" data-id="${esc(s.schedule_id)}"
                      aria-expanded="${shut ? "false" : "true"}"
                      title="${shut ? "Show" : "Hide"} this schedule's steps">
                <span class="tri ${shut ? "" : "open"}">▶</span>${esc(gist)}
              </button>
            </div>
          </div>
          <div class="controls">
            <label class="toggle" title="${on ? "Disable" : "Enable"} this schedule">
              <input type="checkbox" class="enable" data-entity="${esc(s.entity_id)}" ${on ? "checked" : ""}>
              <span></span>
            </label>
            <button class="edit" data-id="${esc(s.schedule_id)}">Edit</button>
          </div>
        </div>
        ${shut ? "" : `<div class="steps">${steps.map((step) => {
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
    }).join("") + add;
  }

  /* --- day-sets ----------------------------------------------------------
   * Read from the roster sensor's `config` (the stored dict, verbatim),
   * written through sb_scheduler.set_day_set / remove_day_set. The backend
   * validates with the same function the Configure form uses, so an error
   * here is the same error you would get there — just shown in the card.
   */

  _dsSummary(d) {
    const c = d.config || {};
    const out = [];
    const wd = c.weekdays || [];
    if (wd.length === 7) out.push("every day");
    else if (wd.length) out.push(wd.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));
    if (c.base_day_set) {
      const b = this._roster().find((x) => x.id === c.base_day_set);
      out.push(`on ${b ? b.name : c.base_day_set}`);
    }
    const cals = (c.base_calendars || c.include_calendars || []).length;
    if (cals) out.push(`${cals} calendar${cals > 1 ? "s" : ""}`);
    if (c.base_dates || c.include_dates) out.push("dates");
    if ((c.exclude_calendars || []).length || c.exclude_dates) out.push("minus cancellations");
    if (d.pick) out.push(d.pick);
    if (d.months) out.push(d.months.map((m) => MONTHS[m - 1]).join("/"));
    if (c.invert) out.push("inverted");
    if (c.offset_days) out.push(`${c.offset_days > 0 ? "+" : ""}${c.offset_days} d`);
    return out.join(" · ");
  }

  _dsListHtml() {
    const rows = this._roster();
    return `<div class="dshead"><span class="dstitle">Day-sets</span>
        <button class="dsclose" title="Close">✕</button></div>
      <div class="hint">Named groups of dates that schedules run on. Build one from weekdays, calendars, typed dates or another day-set, then narrow it to a cadence or an ordinal.</div>
      ${rows.length ? "" : `<div class="empty">No day-sets yet.</div>`}
      ${rows.map((d) => {
        const inUse = (d.used_by?.schedules?.length || 0) + (d.used_by?.day_sets?.length || 0);
        return `<div class="dsrow">
          <div class="info">
            <div class="name">${esc(d.name)}
              ${d.calendar ? "" : `<span class="nocal" title="No calendar entity">no calendar</span>`}</div>
            <div class="meta"><span>${esc(this._dsSummary(d))}</span></div>
            <div class="sub">Next: ${esc(d.next_date ? prettyDate(d.next_date) : "none in horizon")}${
              inUse ? ` · used by ${inUse}` : ""}</div>
          </div>
          <div class="controls">
            <button class="dsedit" data-id="${esc(d.id)}">Edit</button>
          </div>
        </div>`;
      }).join("")}
      <div class="addrow"><button class="dsnew">+ New day-set</button></div>`;
  }

  _beginDsEdit(id) {
    const d = this._roster().find((x) => x.id === id);
    if (!d) return;
    const c = d.config || {};
    this._dsOpen = id;
    this._dsDraft = {
      creating: false, confirmDelete: false, confirmDiscard: null, error: null,
      usedBy: d.used_by || { schedules: [], day_sets: [] },
      name: c.name || d.name || "",
      weekdays: [...(c.weekdays || [])],
      base_day_set: c.base_day_set || "",
      base_calendars: [...(c.base_calendars || c.include_calendars || [])],
      base_dates: c.base_dates || c.include_dates || "",
      exclude_calendars: [...(c.exclude_calendars || [])],
      exclude_dates: c.exclude_dates || "",
      exclude_match: c.exclude_match || "",
      force_calendars: [...(c.force_calendars || [])],
      force_dates: c.force_dates || "",
      force_match: c.force_match || "",
      pick: c.pick || "none",
      pick_every: Number(c.pick_every || 2),
      pick_anchor: c.pick_anchor || "",
      pick_nth: String(c.pick_nth || "1"),
      months: (c.months || []).map(String),
      invert: !!c.invert,
      offset_days: Number(c.offset_days || 0),
      expose_calendar: c.expose_calendar !== false,
      calFilter: "",
    };
    this._dsSnap = snapshot(this._dsDraft);
    this._render();
  }

  _beginDsCreate() {
    this._dsOpen = "__new__";
    this._dsDraft = {
      creating: true, confirmDelete: false, confirmDiscard: null, error: null,
      usedBy: { schedules: [], day_sets: [] },
      name: "", weekdays: [], base_day_set: "", base_calendars: [], base_dates: "",
      exclude_calendars: [], exclude_dates: "", exclude_match: "",
      force_calendars: [], force_dates: "", force_match: "",
      pick: "none", pick_every: 2, pick_anchor: "", pick_nth: "1", months: [],
      invert: false, offset_days: 0, expose_calendar: false, calFilter: "",
    };
    this._dsSnap = snapshot(this._dsDraft);
    this._render();
  }

  /** Back to the list, for real. Save and a confirmed Discard call this. */
  _dsCancel() {
    this._dsOpen = null;
    this._dsDraft = null;
    this._sig = null;
    this._render();
  }

  /** Cancel (→ list), ✕ / Escape (→ close) from the day-set editor: immediate
   *  when nothing changed, otherwise ask and remember where to go. */
  _dsRequestCancel(intent) {
    const d = this._dsDraft;
    if (!d) return;
    if (snapshot(d) === this._dsSnap) {
      if (intent === "close") this._dsClose(); else this._dsCancel();
      return;
    }
    d.confirmDiscard = intent;
    this._render();
  }

  _dsValidate(d) {
    const datesOk = (s) => /^\s*(\d{4}-\d{2}-\d{2}(\s*\.\.\s*\d{4}-\d{2}-\d{2})?\s*(,|\n|$)\s*)*$/.test(s || "");
    if (!d.name.trim()) return "A day-set needs a name.";
    for (const [k, label] of [["base_dates", "Dates"], ["exclude_dates", "Cancelled dates"], ["force_dates", "Always dates"]]) {
      if (!datesOk(d[k])) return `${label}: use YYYY-MM-DD, commas between, ranges as YYYY-MM-DD..YYYY-MM-DD.`;
    }
    if (d.pick === "every" && !d.pick_anchor) return '"Every Nth" needs a starting date.';
    if (d.pick === "every" && !(d.pick_every >= 1)) return "Every N must be at least 1.";
    return null;
  }

  async _dsSave() {
    const d = this._dsDraft;
    const error = this._dsValidate(d);
    if (error) { d.error = error; this._render(); return; }
    const data = {
      name: d.name.trim(),
      weekdays: d.weekdays, base_day_set: d.base_day_set,
      base_calendars: d.base_calendars, base_dates: d.base_dates.trim(),
      exclude_calendars: d.exclude_calendars, exclude_dates: d.exclude_dates.trim(),
      exclude_match: d.exclude_match.trim(),
      force_calendars: d.force_calendars, force_dates: d.force_dates.trim(),
      force_match: d.force_match.trim(),
      pick: d.pick, pick_every: Number(d.pick_every), pick_anchor: d.pick_anchor,
      pick_nth: d.pick_nth, months: d.months,
      invert: d.invert, offset_days: Number(d.offset_days), expose_calendar: d.expose_calendar,
    };
    if (!d.creating) data.id = this._dsOpen;
    try {
      await this._hass.callService("sb_scheduler", "set_day_set", data);
      this._dsCancel();
    } catch (err) {
      d.error = `Save failed: ${err?.message || err}`;
      this._render();
    }
  }

  async _dsDelete() {
    try {
      await this._hass.callService("sb_scheduler", "remove_day_set", { id: this._dsOpen });
      this._dsCancel();
    } catch (err) {
      this._dsDraft.error = `Delete failed: ${err?.message || err}`;
      this._dsDraft.confirmDelete = false;
      this._render();
    }
  }

  _calPickerHtml(field, chosen, filter) {
    const q = String(filter || "").toLowerCase();
    const opts = this._calendarOptions().filter((c) =>
      chosen.includes(c.id) || !q || c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    return `<div class="calpick" data-f="${field}">
      ${opts.map((c) => `<label class="calopt">
        <input type="checkbox" class="cal" data-f="${field}" data-e="${esc(c.id)}" ${chosen.includes(c.id) ? "checked" : ""}>
        <span>${esc(c.name)}</span><span class="calid">${esc(c.id)}</span></label>`).join("")}
      ${opts.length ? "" : `<div class="hint">No calendars match.</div>`}
    </div>`;
  }

  _dsEditorHtml() {
    const d = this._dsDraft;
    const others = this._roster().filter((x) => x.id !== this._dsOpen);
    const inUse = [...(d.usedBy.schedules || []).map((s) => `schedule “${s}”`),
                   ...(d.usedBy.day_sets || []).map((s) => `day-set “${s}”`)];
    const open = (has) => (has ? "open" : "");
    const sec = (title, body, has, extra = "") =>
      `<details class="dsec" ${open(has)}><summary>${title}${extra}</summary><div class="dsecbody">${body}</div></details>`;

    const sources = `
      <div class="field"><span>Weekdays</span>
        <div class="chips">${WEEKDAYS.map((w) => `<label class="chip-t ${d.weekdays.includes(w) ? "on" : ""}">
          <input type="checkbox" class="wd" value="${w}" ${d.weekdays.includes(w) ? "checked" : ""}>${w[0].toUpperCase() + w.slice(1)}</label>`).join("")}</div></div>
      <label class="field"><span>Built on another day-set</span>
        <select id="ds_base"><option value="" ${d.base_day_set ? "" : "selected"}>—</option>
          ${others.map((o) => `<option value="${esc(o.id)}" ${o.id === d.base_day_set ? "selected" : ""}>${esc(o.name)}</option>`).join("")}
        </select></label>
      <div class="field"><span>Calendars</span>
        <input id="ds_calfilter" type="text" placeholder="Filter calendars…" value="${esc(d.calFilter)}">
        ${this._calPickerHtml("base_calendars", d.base_calendars, d.calFilter)}</div>
      <label class="field"><span>Dates</span>
        <textarea id="ds_base_dates" rows="2" placeholder="2026-12-25, 2027-06-05..2027-08-17">${esc(d.base_dates)}</textarea></label>`;

    const cancelled = `
      <div class="field"><span>Cancelled by these calendars</span>
        ${this._calPickerHtml("exclude_calendars", d.exclude_calendars, d.calFilter)}</div>
      <label class="field"><span>…and these dates</span>
        <textarea id="ds_exclude_dates" rows="2" placeholder="2026-12-25, 2027-06-05..2027-08-17">${esc(d.exclude_dates)}</textarea></label>
      <label class="field"><span>Only cancel when the entry matches</span>
        <input id="ds_exclude_match" type="text" value="${esc(d.exclude_match)}"></label>`;

    const always = `
      <div class="field"><span>Always included by these calendars</span>
        ${this._calPickerHtml("force_calendars", d.force_calendars, d.calFilter)}</div>
      <label class="field"><span>…and these dates</span>
        <textarea id="ds_force_dates" rows="2" placeholder="2026-12-25, 2027-06-05..2027-08-17">${esc(d.force_dates)}</textarea></label>
      <label class="field"><span>Only force when the entry matches</span>
        <input id="ds_force_match" type="text" value="${esc(d.force_match)}"></label>`;

    const pick = `
      <label class="field"><span>Pick</span>
        <select id="ds_pick">
          <option value="none" ${d.pick === "none" ? "selected" : ""}>Every eligible date</option>
          <option value="every" ${d.pick === "every" ? "selected" : ""}>Every Nth eligible date, from a starting date</option>
          <option value="nth_of_month" ${d.pick === "nth_of_month" ? "selected" : ""}>The Nth (or last) eligible date of each month</option>
        </select></label>
      ${d.pick === "every" ? `
        <div class="pair">
          <label class="field inline"><span>Every N</span><input id="ds_every" type="number" min="1" max="366" value="${esc(d.pick_every)}"></label>
          <label class="field inline"><span>Starting on</span><input id="ds_anchor" type="date" value="${esc(d.pick_anchor)}"></label>
        </div>
        <div class="hint">Counts eligible dates, not calendar days — every 14th day from a Tuesday is every other Tuesday.</div>` : ""}
      ${d.pick === "nth_of_month" ? `
        <label class="field"><span>Which one each month</span>
          <select id="ds_nth">${["1", "2", "3", "4", "5", "last"].map((n) =>
            `<option value="${n}" ${d.pick_nth === n ? "selected" : ""}>${{ "1": "First", "2": "Second", "3": "Third", "4": "Fourth", "5": "Fifth", "last": "Last" }[n]}</option>`).join("")}</select></label>` : ""}
      <div class="field"><span>Only in these months</span>
        <div class="chips">${MONTHS.map((m, i) => { const v = String(i + 1); const on = d.months.includes(v);
          return `<label class="chip-t ${on ? "on" : ""}"><input type="checkbox" class="mo" value="${v}" ${on ? "checked" : ""}>${m}</label>`; }).join("")}</div></div>`;

    const advanced = `
      <label class="row-t"><input id="ds_invert" type="checkbox" ${d.invert ? "checked" : ""}> Invert (every date NOT in this set)</label>
      <label class="field"><span>Shift by (days)</span><input id="ds_offset" type="number" min="-30" max="30" value="${esc(d.offset_days)}"></label>
      <label class="row-t"><input id="ds_expose" type="checkbox" ${d.expose_calendar ? "checked" : ""}> Show as a calendar entity</label>`;

    return `
      <div class="dshead"><span class="dstitle">${d.creating ? "New day-set" : "Edit day-set"}</span>
        <button class="dsclose" title="Close">✕</button></div>
      ${d.confirmDiscard ? `
        <div class="confirm discard">Discard unsaved changes?
          <div class="buttons"><button class="dskeepediting">Keep editing</button>
            <button class="dsdiscard danger">Discard</button></div>
        </div>` : ""}
      ${d.error ? `<div class="error">${esc(d.error)}</div>` : ""}
      <label class="field"><span>Name</span><input id="ds_name" type="text" value="${esc(d.name)}"></label>
      ${sec("Sources — where the dates come from", sources, true)}
      ${sec("Cancelled — what takes a day back out", cancelled, d.exclude_calendars.length || d.exclude_dates)}
      ${sec("Always — what overrides a cancellation", always, d.force_calendars.length || d.force_dates)}
      ${sec("Pick — cadence, ordinal, months", pick, d.pick !== "none" || d.months.length)}
      ${sec("Advanced", advanced, d.invert || d.offset_days || !d.expose_calendar)}
      ${d.confirmDelete ? `
        <div class="confirm">Delete this day-set?
          <div class="buttons"><button class="dsnodelete">Keep it</button><button class="dsdodelete danger">Delete</button></div>
        </div>` : `
        <div class="buttons">
          ${d.creating ? "" : inUse.length
            ? `<span class="hint">In use by ${esc(inUse.join(", "))} — change those to delete.</span>`
            : `<button class="dsaskdelete danger-text">Delete day-set</button>`}
          <span class="spacer"></span>
          <button class="dscancel">Cancel</button>
          <button class="dssave save">${d.creating ? "Create" : "Save"}</button>
        </div>`}`;
  }

  _wireDaySets(root) {
    root.querySelector("button.dsopen")?.addEventListener("click", () => {
      this._dsDialog = "list";
      this._render();
    });
    const dlg = root.querySelector("dialog.dsdialog");
    if (dlg) {
      this._guardScroll(dlg);
      // Escape closes the native dialog. From the list that is final; from
      // the editor it goes through the dirty check, and a re-render brings the
      // dialog back with the prompt if there is unsaved work. A backdrop
      // click does nothing on purpose.
      dlg.addEventListener("close", () => {
        if (!this._dsDialog) return;
        if (this._dsOpen) this._dsRequestCancel("close"); else this._dsClose();
      });
      root.querySelectorAll("button.dsclose").forEach((b) =>
        b.addEventListener("click", () =>
          this._dsOpen ? this._dsRequestCancel("close") : this._dsClose()));
      root.querySelector("button.dskeepediting")?.addEventListener("click", () => {
        this._dsDraft.confirmDiscard = null; this._render();
      });
      root.querySelector("button.dsdiscard")?.addEventListener("click", () => {
        const intent = this._dsDraft?.confirmDiscard;
        if (intent === "close") this._dsClose(); else this._dsCancel();
      });
    }
    root.querySelectorAll("button.dsedit").forEach((b) =>
      b.addEventListener("click", () => this._beginDsEdit(b.dataset.id)));
    root.querySelector("button.dsnew")?.addEventListener("click", () => this._beginDsCreate());
    if (!this._dsOpen) return;
    const d = this._dsDraft;
    const bind = (id, key, fn = (v) => v, evt = "input") => {
      const el = root.querySelector(`#${id}`);
      if (el) el.addEventListener(evt, () => { d[key] = fn(el.value); d.error = null; });
    };
    bind("ds_name", "name");
    bind("ds_base_dates", "base_dates");
    bind("ds_exclude_dates", "exclude_dates");
    bind("ds_exclude_match", "exclude_match");
    bind("ds_force_dates", "force_dates");
    bind("ds_force_match", "force_match");
    bind("ds_every", "pick_every", Number);
    bind("ds_anchor", "pick_anchor");
    bind("ds_offset", "offset_days", Number);
    bind("ds_base", "base_day_set", (v) => v, "change");
    bind("ds_nth", "pick_nth", (v) => v, "change");
    root.querySelector("#ds_pick")?.addEventListener("change", (e) => { d.pick = e.target.value; d.error = null; this._render(); });
    root.querySelector("#ds_invert")?.addEventListener("change", (e) => { d.invert = e.target.checked; });
    root.querySelector("#ds_expose")?.addEventListener("change", (e) => { d.expose_calendar = e.target.checked; });
    root.querySelectorAll("input.wd").forEach((box) => box.addEventListener("change", () => {
      d.weekdays = WEEKDAYS.filter((w) => w === box.value ? box.checked : d.weekdays.includes(w));
      box.closest("label").classList.toggle("on", box.checked);
    }));
    root.querySelectorAll("input.mo").forEach((box) => box.addEventListener("change", () => {
      d.months = box.checked ? [...new Set([...d.months, box.value])] : d.months.filter((m) => m !== box.value);
      box.closest("label").classList.toggle("on", box.checked);
    }));
    root.querySelectorAll("input.cal").forEach((box) => box.addEventListener("change", () => {
      const f = box.dataset.f, e = box.dataset.e;
      d[f] = box.checked ? [...new Set([...d[f], e])] : d[f].filter((x) => x !== e);
    }));
    // The filter re-renders the three pickers IN PLACE so typing keeps focus.
    const filt = root.querySelector("#ds_calfilter");
    if (filt) filt.addEventListener("input", () => {
      d.calFilter = filt.value;
      for (const f of ["base_calendars", "exclude_calendars", "force_calendars"]) {
        const box = root.querySelector(`.calpick[data-f="${f}"]`);
        if (!box) continue;
        box.outerHTML = this._calPickerHtml(f, d[f], d.calFilter);
      }
      root.querySelectorAll("input.cal").forEach((box) => box.addEventListener("change", () => {
        const f = box.dataset.f, e = box.dataset.e;
        d[f] = box.checked ? [...new Set([...d[f], e])] : d[f].filter((x) => x !== e);
      }));
    });
    root.querySelector("button.dscancel")?.addEventListener("click", () => this._dsRequestCancel("list"));
    root.querySelector("button.dssave")?.addEventListener("click", () => this._dsSave());
    root.querySelector("button.dsaskdelete")?.addEventListener("click", () => { d.confirmDelete = true; this._render(); });
    root.querySelector("button.dsnodelete")?.addEventListener("click", () => { d.confirmDelete = false; this._render(); });
    root.querySelector("button.dsdodelete")?.addEventListener("click", () => this._dsDelete());
  }

  _editorHtml() {
    const d = this._draft;
    const daySets = this._daySets();
    const known = daySets.some((x) => x.id === d.day_set);
    return `
      <div class="dshead"><span class="dstitle">${d.creating ? "New schedule" : "Edit schedule"}</span>
        <button class="scclose" title="Close">✕</button></div>
      ${d.confirmDiscard ? `
        <div class="confirm discard">Discard unsaved changes?
          <div class="buttons"><button class="keepediting">Keep editing</button>
            <button class="discard danger">Discard</button></div>
        </div>` : ""}
      ${d.error ? `<div class="error">${esc(d.error)}</div>` : ""}
      <label class="field"><span>Name</span>
        <input id="name" type="text" value="${esc(d.name)}"
               placeholder="${d.creating ? "New schedule" : ""}"></label>

      <label class="field"><span>Runs on</span>
        <select id="day_set">
          ${daySets.map((x) => `<option value="${esc(x.id)}" ${x.id === d.day_set ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
          ${known ? "" : `<option value="${esc(d.day_set)}" selected>${esc(d.day_set)} (missing)</option>`}
        </select></label>
      ${known ? "" : `<div class="warn">This schedule points at a day-set that no longer exists, so it cannot run.</div>`}

      ${d.steps.map((step, si) => this._stepHtml(step, si, d.steps.length)).join("")}
      <button class="addstep">+ Add a step</button>

      ${d.confirmDelete ? `
        <div class="confirm">
          Delete this schedule? Its steps and run history go with it.
          <div class="buttons">
            <button class="nodelete">Keep it</button>
            <button class="dodelete danger">Delete</button>
          </div>
        </div>` : `
        <div class="buttons">
          ${d.creating ? "" : `<button class="askdelete danger-text">Delete schedule</button>`}
          <span class="spacer"></span>
          <button class="cancel">Cancel</button>
          <button class="save">${d.creating ? "Create" : "Save"}</button>
        </div>`}`;
  }

  _stepHtml(step, si, total) {
    return `
      <div class="stepedit ${step.enabled ? "" : "off"}">
        <div class="stephead">
          <input class="step-name" data-s="${si}" type="text" value="${esc(step.name)}"
                 placeholder="Step name">
          <label class="toggle small" title="${step.enabled ? "Disable" : "Enable"} this step">
            <input type="checkbox" class="step-on" data-s="${si}" ${step.enabled ? "checked" : ""}>
            <span></span>
          </label>
          ${total > 1 ? `<button class="dropstep" data-s="${si}" title="Remove this step">✕</button>` : ""}
        </div>

        <div class="field"><span class="sect">Times</span>
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

        <div class="field"><span class="sect">Actions</span></div>
        ${step.actions.map((a, ai) => this._actionHtml(a, si, ai)).join("")}
        <button class="addaction" data-s="${si}">+ Add an action</button>
      </div>`;
  }

  _actionHtml(a, si, ai) {
    const entities = a.mode === "entity"
      ? this._entityOptions(a.filter, a.filter ? "" : a.domain, a.entity_id) : [];
    const services = this._servicesFor(a.domain);
    const spare = this._spareFields(a);
    return `
      <div class="action" data-s="${si}" data-a="${ai}">
        <div class="arow">
          <div class="radios small">
            <label><input type="radio" name="amode${si}_${ai}" data-s="${si}" data-a="${ai}"
              value="entity" ${a.mode === "entity" ? "checked" : ""}> Entity</label>
            <label><input type="radio" name="amode${si}_${ai}" data-s="${si}" data-a="${ai}"
              value="service" ${a.mode === "service" ? "checked" : ""}> Service only</label>
          </div>
          <button class="dropaction" data-s="${si}" data-a="${ai}" title="Remove this action">✕</button>
        </div>

        ${a.mode === "entity" ? `
          <input class="ent-filter" data-s="${si}" data-a="${ai}" type="text"
                 placeholder="Filter entities…" value="${esc(a.filter)}">
          <select class="ent-pick" data-s="${si}" data-a="${ai}">
            ${a.entity_id ? "" : `<option value="" selected>Choose an entity…</option>`}
            ${entities.map((e) => `<option value="${esc(e.id)}" ${e.id === a.entity_id ? "selected" : ""}>${esc(e.name)} — ${esc(e.id)}</option>`).join("")}
          </select>
          <select class="act-service" data-s="${si}" data-a="${ai}">
            ${services.map((v) => `<option value="${esc(v)}" ${v === a.service ? "selected" : ""}>${esc(a.domain)}.${esc(v)}</option>`).join("")}
            ${services.includes(a.service) ? "" : `<option value="${esc(a.service)}" selected>${esc(a.domain)}.${esc(a.service)} (unknown)</option>`}
          </select>
        ` : `
          <div class="pair">
            <select class="act-domain" data-s="${si}" data-a="${ai}">
              ${this._domains().map((v) => `<option value="${esc(v)}" ${v === a.domain ? "selected" : ""}>${esc(v)}</option>`).join("")}
              ${this._domains().includes(a.domain) ? "" : `<option value="${esc(a.domain)}" selected>${esc(a.domain)} (unknown)</option>`}
            </select>
            <select class="act-service" data-s="${si}" data-a="${ai}">
              ${services.map((v) => `<option value="${esc(v)}" ${v === a.service ? "selected" : ""}>${esc(v)}</option>`).join("")}
              ${services.includes(a.service) ? "" : `<option value="${esc(a.service)}" selected>${esc(a.service)} (unknown)</option>`}
            </select>
          </div>`}

        ${Object.keys(a.data).map((k) => this._fieldHtml(a, k, si, ai)).join("")}
        ${spare.length ? `
          <select class="addfield" data-s="${si}" data-a="${ai}">
            <option value="" selected>+ Add a field…</option>
            ${spare.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}
          </select>` : ""}
      </div>`;
  }

  _fieldHtml(a, key, si, ai) {
    const v = a.data[key];
    const kind = valueKind(v);
    const meta = this._fieldMeta(a, key);
    const num = meta?.selector?.number || {};
    const common = `data-s="${si}" data-a="${ai}" data-k="${esc(key)}"`;
    // An opaque value (notify's data: {tag, channel}) is shown but NOT edited:
    // rendering it as text and re-parsing is how a tag gets silently dropped.
    const control = kind === "opaque"
      ? `<span class="opaque" title="Edit this with the sb_scheduler.edit_schedule action">${esc(JSON.stringify(v))}</span>`
      : kind === "boolean"
        ? `<label class="toggle small"><input type="checkbox" class="fld-bool" ${common} ${v ? "checked" : ""}><span></span></label>`
        : kind === "number"
          ? `<input class="fld-num" ${common} type="number" value="${esc(v)}"
               ${num.min !== undefined ? `min="${esc(num.min)}"` : ""}
               ${num.max !== undefined ? `max="${esc(num.max)}"` : ""}
               ${num.step !== undefined ? `step="${esc(num.step)}"` : ""}>`
          : `<input class="fld-text" ${common} type="text" value="${esc(v)}">`;
    return `<div class="fieldrow">
      <span class="fkey" title="${esc(meta.description || "")}">${esc(key)}</span>
      ${control}
      ${kind === "opaque" ? "" : `<button class="dropfield" ${common} title="Remove">✕</button>`}
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
    this._wireDaySets(root);
    const sc = root.querySelector("dialog.scdialog");
    if (sc) {
      this._guardScroll(sc);
      // Escape closes the native dialog; if there is unsaved work the
      // re-render brings it straight back with the discard prompt showing.
      sc.addEventListener("close", () => { if (this._open) this._requestCancel(); });
      root.querySelectorAll("button.scclose").forEach((b) =>
        b.addEventListener("click", () => this._requestCancel()));
      root.querySelector("button.keepediting")?.addEventListener("click", () => {
        this._draft.confirmDiscard = false; this._render();
      });
      root.querySelector("button.discard")?.addEventListener("click", () => this._cancel());
    }
    root.querySelectorAll("button.edit").forEach((b) =>
      b.addEventListener("click", () => this._beginEdit(b.dataset.id)));
    root.querySelector("button.new")?.addEventListener("click", () => this._beginCreate());

    root.querySelectorAll("button.disclose").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.id;
        if (this._collapsed.has(id)) this._collapsed.delete(id);
        else this._collapsed.add(id);
        this._writeCollapsed();
        this._render();
      }));

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
    const actOf = (el) => d.steps[Number(el.dataset.s)].actions[Number(el.dataset.a)];

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

    root.querySelectorAll('input[type="radio"][data-s]:not([data-a])').forEach((r) =>
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

    // --- steps
    root.querySelector("button.addstep")?.addEventListener("click", () => {
      d.steps.push({ ...blankStep(), name: `Step ${d.steps.length + 1}` });
      d.error = null;
      this._render();
    });
    root.querySelectorAll("button.dropstep").forEach((b) =>
      b.addEventListener("click", () => {
        // Draft-local, so Cancel still undoes it — no confirmation needed.
        d.steps.splice(Number(b.dataset.s), 1);
        d.error = null;
        this._render();
      }));

    // --- actions
    root.querySelectorAll("button.addaction").forEach((b) =>
      b.addEventListener("click", () => {
        stepOf(b).actions.push({
          mode: "entity", domain: "light", service: "turn_on",
          entity_id: "", filter: "", data: {},
        });
        d.error = null;
        this._render();
      }));
    root.querySelectorAll("button.dropaction").forEach((b) =>
      b.addEventListener("click", () => {
        stepOf(b).actions.splice(Number(b.dataset.a), 1);
        d.error = null;
        this._render();
      }));

    root.querySelectorAll('input[type="radio"][data-a]').forEach((r) =>
      r.addEventListener("change", () => {
        if (!r.checked) return;
        const a = actOf(r);
        a.mode = r.value;
        if (a.mode === "service") a.entity_id = "";
        d.error = null;
        this._render();
      }));

    // The filter repopulates its own select IN PLACE: re-rendering here would
    // steal focus and the cursor on every keystroke.
    root.querySelectorAll("input.ent-filter").forEach((el) =>
      el.addEventListener("input", () => {
        const a = actOf(el);
        a.filter = el.value;
        const sel = root.querySelector(`select.ent-pick[data-s="${el.dataset.s}"][data-a="${el.dataset.a}"]`);
        if (!sel) return;
        const opts = this._entityOptions(a.filter, a.filter ? "" : a.domain, a.entity_id);
        sel.innerHTML = (a.entity_id ? "" : `<option value="">Choose an entity…</option>`) +
          opts.map((e) => `<option value="${esc(e.id)}" ${e.id === a.entity_id ? "selected" : ""}>${esc(e.name)} — ${esc(e.id)}</option>`).join("");
      }));

    root.querySelectorAll("select.ent-pick").forEach((sel) =>
      sel.addEventListener("change", () => {
        const a = actOf(sel);
        a.entity_id = sel.value;
        const domain = sel.value.split(".")[0];
        if (domain && domain !== a.domain) {
          // The service belongs to the entity's domain, so it has to follow.
          a.domain = domain;
          const svcs = this._servicesFor(domain);
          if (!svcs.includes(a.service)) a.service = svcs[0] || "";
          a.data = {};
        }
        d.error = null;
        this._render();
      }));

    root.querySelectorAll("select.act-domain").forEach((sel) =>
      sel.addEventListener("change", () => {
        const a = actOf(sel);
        a.domain = sel.value;
        const svcs = this._servicesFor(a.domain);
        if (!svcs.includes(a.service)) a.service = svcs[0] || "";
        a.data = {};
        d.error = null;
        this._render();
      }));

    root.querySelectorAll("select.act-service").forEach((sel) =>
      sel.addEventListener("change", () => {
        actOf(sel).service = sel.value;
        d.error = null;
        this._render();
      }));

    root.querySelectorAll("select.addfield").forEach((sel) =>
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        const a = actOf(sel);
        const meta = this._fieldMeta(a, sel.value);
        const s = meta.selector || {};
        a.data[sel.value] = "number" in s ? (s.number?.min ?? 0)
          : "boolean" in s ? false : "";
        d.error = null;
        this._render();
      }));

    root.querySelectorAll("input.fld-text").forEach((el) =>
      el.addEventListener("input", () => { actOf(el).data[el.dataset.k] = el.value; }));
    root.querySelectorAll("input.fld-num").forEach((el) =>
      el.addEventListener("input", () => { actOf(el).data[el.dataset.k] = Number(el.value); }));
    root.querySelectorAll("input.fld-bool").forEach((el) =>
      el.addEventListener("change", () => { actOf(el).data[el.dataset.k] = el.checked; }));
    root.querySelectorAll("button.dropfield").forEach((b) =>
      b.addEventListener("click", () => {
        delete actOf(b).data[b.dataset.k];
        this._render();
      }));

    // --- buttons
    root.querySelector("button.cancel")?.addEventListener("click", () => this._requestCancel());
    root.querySelector("button.save")?.addEventListener("click", () => this._save());
    root.querySelector("button.askdelete")?.addEventListener("click", () => {
      d.confirmDelete = true;
      this._render();
    });
    root.querySelector("button.nodelete")?.addEventListener("click", () => {
      d.confirmDelete = false;
      this._render();
    });
    root.querySelector("button.dodelete")?.addEventListener("click", () => this._delete());
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
/* The disclosure is text, not a chrome button: it sits in the meta line and
   reads as part of it, so it takes no border or padding of its own. */
button.disclose { border: none; background: none; padding: 0; font: inherit;
                  font-size: .9em; color: var(--secondary-text-color);
                  display: inline-flex; align-items: center; gap: 5px; }
button.disclose:hover { color: var(--primary-text-color); }
.tri { display: inline-block; font-size: .7em; line-height: 1;
       transition: transform .15s; color: var(--secondary-text-color); }
.tri.open { transform: rotate(90deg); }
/* Steps sit under their schedule, indented and on a rail, so a two-step
   schedule reads as one thing with two parts rather than two schedules. */
.steps { margin: 6px 0 0 8px; padding-left: 12px;
         border-left: 2px solid var(--divider-color); }
.step { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; }
/* Steps live inside an already-indented row, so they wrap narrower than the
   schedule itself — otherwise every step in a sidebar-width column spills. */
.step .info { flex: 1 1 110px; min-width: 110px; }
.step .controls { gap: 6px; }
.step .controls button { padding: 3px 8px; font-size: .85em; }
.step.disabled .sname, .step.disabled .sub { opacity: .5; }
.sname { font-size: .95em; }
.stimes { color: var(--secondary-text-color); font-size: .9em; margin-left: 8px; }
.controls { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
.controls button { white-space: nowrap; }
.controls button[disabled] { opacity: .6; cursor: default; }
.addrow { padding-top: 12px; }
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
button.danger { background: var(--error-color); color: var(--text-primary-color);
                border-color: transparent; }
button.danger-text { color: var(--error-color); border-color: transparent; background: none;
                     padding-left: 0; }
button.drop, button.dropstep, button.dropaction, button.dropfield {
  border: none; background: none; color: var(--error-color); padding: 4px 8px; }
.field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
.field > span { color: var(--secondary-text-color); font-size: .85em; }
/* Times and Actions are the step's two sections, not field labels like Name —
   they carry the rows below them, so they read a size up and in full colour. */
.field > span.sect { font-size: 1em; font-weight: 600; color: var(--primary-text-color); }
.field.inline { flex: 1; }
input, select { font: inherit; padding: 8px; border-radius: 6px;
                border: 1px solid var(--divider-color);
                background: var(--card-background-color); color: var(--primary-text-color); }
option { background: var(--card-background-color); color: var(--primary-text-color); }
.radios { display: flex; gap: 16px; flex-wrap: wrap; }
.radios.small { font-size: .85em; gap: 10px; }
.radios label { display: flex; align-items: center; gap: 6px; }
.times { display: flex; flex-direction: column; gap: 6px; }
/* Same rail as an action: a time is a row belonging to this step, and the two
   sections should read the same way down the left edge. */
.timerow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
           border-left: 2px solid var(--divider-color); padding: 6px 0 6px 10px; }
.interval { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;
            border-left: 2px solid var(--divider-color); padding-left: 10px; }
.count { color: var(--secondary-text-color); font-size: .85em; padding-bottom: 10px; }
/* Each step is a card within the editor, or a multi-step schedule becomes an
   undifferentiated wall of time rows. */
.stepedit { border: 1px solid var(--divider-color); border-radius: 8px;
            padding: 4px 12px 12px; margin: 12px 0; }
.stepedit.off { opacity: .6; }
.stephead { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.stephead .step-name { flex: 1; font-weight: 500; }
/* An action nests one level deeper again, so it gets a softer rail. */
.action { border-left: 2px solid var(--divider-color); padding: 6px 0 6px 10px;
          margin: 6px 0; display: flex; flex-direction: column; gap: 6px; }
.arow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pair { display: flex; gap: 6px; }
.pair select { flex: 1; min-width: 0; }
.fieldrow { display: flex; align-items: center; gap: 8px; }
.fkey { font-size: .85em; color: var(--secondary-text-color); flex: 0 0 96px;
        overflow: hidden; text-overflow: ellipsis; }
.fieldrow input { flex: 1; min-width: 0; }
.opaque { flex: 1; font-size: .8em; color: var(--secondary-text-color);
          font-family: monospace; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; }
.modelbl { font-size: .8em; color: var(--secondary-text-color); }
.modelbl.on { color: var(--primary-text-color); font-weight: 500; }
.timerow select { padding: 7px 6px; }
.occ-mins { width: 76px; }
.unit { font-size: .8em; color: var(--secondary-text-color); }
.buttons { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.buttons .spacer { flex: 1; }
.confirm { border: 1px solid var(--error-color); border-radius: 8px; padding: 12px;
           margin-top: 16px; font-size: .9em; }
.confirm .buttons { margin-top: 8px; justify-content: flex-end; }
.error { background: var(--error-color); color: var(--text-primary-color);
         padding: 8px 12px; border-radius: 6px; margin-bottom: 8px; }
.warn { color: var(--warning-color); font-size: .85em; margin: -6px 0 8px; }
code { background: var(--secondary-background-color); padding: 1px 4px; border-radius: 3px; }
/* --- day-sets: a modal dialog, so the main card stays just schedules --- */
.addrow { display: flex; gap: 8px; flex-wrap: wrap; }
dialog.dsdialog, dialog.scdialog {
                  border: none; border-radius: 12px; padding: 0;
                  width: min(720px, 95vw); max-height: 90vh;
                  background: var(--card-background-color, #fff);
                  color: var(--primary-text-color, #212121);
                  box-shadow: 0 8px 32px rgba(0,0,0,.35); }
dialog.dsdialog::backdrop, dialog.scdialog::backdrop { background: rgba(0,0,0,.45); }
button.scclose { border: none; background: none; font-size: 1.1em; padding: 4px 8px;
                 color: var(--secondary-text-color); }
button.scclose:hover { color: var(--primary-text-color); }
/* overscroll-behavior: contain keeps the body's own scrolling from chaining
   to the dashboard behind the dialog once it reaches its top or bottom. */
.dsdialog-body { padding: 12px 20px 20px; max-height: 90vh; overflow: auto;
                 box-sizing: border-box; overscroll-behavior: contain; }
dialog.dsdialog, dialog.scdialog { overscroll-behavior: contain; }
.confirm.discard { border-color: var(--warning-color, #ff9800); margin: 0 0 12px; }
.dshead { display: flex; align-items: center; justify-content: space-between;
          margin: 4px 0 8px; }
.dshead .dstitle { margin: 0; }
button.dsclose { border: none; background: none; font-size: 1.1em; padding: 4px 8px;
                 color: var(--secondary-text-color); }
button.dsclose:hover { color: var(--primary-text-color); }
.dsrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 0;
         border-bottom: 1px solid var(--divider-color); }
.dsrow:last-of-type { border-bottom: none; }
.nocal { font-size: .75em; color: var(--secondary-text-color); margin-left: 8px;
         border: 1px solid var(--divider-color); border-radius: 8px; padding: 0 6px; }
.dstitle { font-weight: 600; font-size: 1.05em; margin: 4px 0 8px; }
.dsec { border: 1px solid var(--divider-color); border-radius: 8px; margin: 10px 0; }
.dsec > summary { cursor: pointer; padding: 8px 12px; font-weight: 500; list-style: none; }
.dsec > summary::before { content: "\\25B6"; display: inline-block; font-size: .7em; margin-right: 8px;
                          transition: transform .15s; color: var(--secondary-text-color); }
.dsec[open] > summary::before { transform: rotate(90deg); }
.dsecbody { padding: 0 12px 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-t { border: 1px solid var(--divider-color); border-radius: 12px; padding: 3px 10px;
          font-size: .85em; cursor: pointer; user-select: none; }
.chip-t input { display: none; }
.chip-t.on { background: var(--primary-color); color: var(--text-primary-color); border-color: transparent; }
.row-t { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
textarea { font: inherit; padding: 8px; border-radius: 6px; border: 1px solid var(--divider-color);
           background: var(--card-background-color); color: var(--primary-text-color); resize: vertical; }
.calpick { max-height: 180px; overflow: auto; border: 1px solid var(--divider-color);
           border-radius: 6px; padding: 4px 8px; margin-top: 4px; }
.calopt { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: .9em; cursor: pointer; }
.calopt .calid { color: var(--secondary-text-color); font-size: .8em; margin-left: auto;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
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
  description: "Create and edit sb_scheduler schedules: day-sets, steps, times and actions.",
  preview: false,
  documentationURL: "https://github.com/snadboy/sb-scheduler",
});

console.info(`%c ${CARD.toUpperCase()} %c v${VERSION} `,
  "color:white;background:#3f51b5;font-weight:700",
  "color:#3f51b5;background:white;font-weight:700");
