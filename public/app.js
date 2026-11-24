(() => {
  "use strict";

  const STORE_KEY = "complimed-queue-v1";
  const ROLE_KEY = "complimed-role";
  const CONCURRENCY = 3;
  const SEV_RANK = { CRITICAL: 0, HIGH: 1, REVIEW: 2, MEDIUM: 3, LOW: 4, NONE: 5 };

  const WORKFLOW = {
    open: { label: "Needs action", cls: "high" },
    clean: { label: "Ready to submit", cls: "ok" },
    fixed: { label: "Fixed", cls: "ok" },
    provider: { label: "Sent to provider", cls: "info" },
    escalated: { label: "Escalated to coder", cls: "review" },
    overridden: { label: "Overridden", cls: "neutral" },
  };
  const RESOLVED = new Set(["clean", "fixed", "provider", "overridden"]);

  const $ = (sel) => document.querySelector(sel);
  const els = {
    rows: $("#rows"), empty: $("#empty"), stats: $("#stats"), tabs: $("#tabs"),
    detail: $("#detail"), search: $("#search"), file: $("#file-input"),
    sample: $("#load-sample"), exportBtn: $("#export"), clear: $("#clear"),
    toast: $("#toast"),
    dialog: $("#override-dialog"), reason: $("#override-reason"),
    overrideCancel: $("#override-cancel"),
  };

  let state = load();
  let role = localStorage.getItem(ROLE_KEY) || "coder";
  let tab = "mine";
  let selected = null;
  let query = "";

  // ---------- persistence ----------
  function load() {
    try {
      const items = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      // Anything mid-audit when the page closed goes back in the queue.
      items.forEach((it) => { if (it.status === "auditing") it.status = "queued"; });
      return items;
    } catch { return []; }
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const now = () => new Date().toISOString();
  const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  // Admin staff can resolve privacy and prior-auth problems; code changes need a coder.
  function violationOwner(v) {
    const id = String(v.rule_id || "").toUpperCase();
    return /HIPAA|PRIVACY|PHI|AUTH/.test(id) ? "admin" : "coder";
  }

  function itemOwner(it) {
    const r = it.report;
    if (!r) return null;
    if (it.workflow === "escalated") return "coder";
    const vs = r.violations || [];
    if (r.human_in_the_loop_required || vs.some((v) => violationOwner(v) === "coder")) return "coder";
    if (vs.length) return "admin";
    return null;
  }

  function topSeverity(it) {
    const r = it.report;
    if (!r) return "NONE";
    let best = "NONE";
    for (const v of r.violations || []) {
      const s = String(v.severity || "").toUpperCase();
      if ((SEV_RANK[s] ?? 9) < SEV_RANK[best]) best = s;
    }
    if (r.human_in_the_loop_required && SEV_RANK.REVIEW < SEV_RANK[best]) best = "REVIEW";
    return best;
  }

  function addHistory(it, text) {
    it.history.push({ at: now(), who: role === "coder" ? "Coder" : "Admin", text });
  }

  // ---------- intake ----------
  function normalizeInput(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : [raw];
    return list.map((x) => (x && x.record ? x.record : x)).filter((x) => x && typeof x === "object");
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f.trim())) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim())) rows.push(row);
    if (rows.length < 2) return [];
    const head = rows[0].map((h) => h.trim().toLowerCase());
    return rows.slice(1).map((r) => {
      const o = {};
      head.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
      o.icd10_codes = splitCodes(o.icd10_codes);
      o.cpt_codes = splitCodes(o.cpt_codes);
      return o;
    });
  }
  const splitCodes = (s) => String(s || "").split(/[;|,\s]+/).map((c) => c.trim()).filter(Boolean);

  function enqueue(records) {
    if (!records.length) return toast("No records found in that file.");
    const items = records.map((record) => ({
      key: uid(), record, status: "queued", report: null, engine: null,
      error: null, workflow: null, history: [{ at: now(), who: "System", text: "Added to queue" }],
    }));
    state.push(...items);
    save();
    render();
    toast(`${items.length} record${items.length === 1 ? "" : "s"} added. Auditing…`);
    pump();
  }

  // ---------- auditing ----------
  let running = 0;
  function pump() {
    while (running < CONCURRENCY) {
      const it = state.find((x) => x.status === "queued");
      if (!it) break;
      running++;
      it.status = "auditing";
      render();
      auditOne(it).finally(() => { running--; save(); render(); pump(); });
    }
  }

  async function auditOne(it) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ record: it.record }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        it.report = data.report;
        it.engine = data.engine;
        it.status = "done";
        it.error = null;
        const n = (data.report.violations || []).length;
        it.workflow = n === 0 && !data.report.human_in_the_loop_required ? "clean" : "open";
        it.history.push({ at: now(), who: "System", text: n ? `Audit found ${n} issue${n === 1 ? "" : "s"}` : "Audit passed" });
        return;
      } catch (err) {
        it.error = err.message;
      }
    }
    it.status = "error";
  }

  // ---------- views ----------
  function visibleItems() {
    const q = query.trim().toLowerCase();
    return state
      .filter((it) => {
        const done = it.status === "done";
        const resolved = done && RESOLVED.has(it.workflow);
        if (tab === "mine" && !(done && !resolved && itemOwner(it) === role)) return false;
        if (tab === "open" && !(done && !resolved)) return false;
        if (tab === "resolved" && !resolved) return false;
        if (!q) return true;
        const r = it.record;
        const hay = [r.record_id, r.department, r.provider_id, ...(r.icd10_codes || []), ...(r.cpt_codes || []),
          ...((it.report?.violations || []).map((v) => v.rule_id))].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const pa = a.status === "done" ? 0 : 1, pb = b.status === "done" ? 0 : 1;
        if (pa !== pb) return pb - pa; // pending first so progress is visible
        const ra = RESOLVED.has(a.workflow) ? 1 : 0, rb = RESOLVED.has(b.workflow) ? 1 : 0;
        if (ra !== rb) return ra - rb;
        return SEV_RANK[topSeverity(a)] - SEV_RANK[topSeverity(b)] ||
          String(a.record.record_id).localeCompare(String(b.record.record_id));
      });
  }

  function counts() {
    const done = state.filter((x) => x.status === "done");
    const open = done.filter((x) => !RESOLVED.has(x.workflow));
    return {
      total: state.length,
      done: done.length,
      pending: state.filter((x) => x.status === "queued" || x.status === "auditing").length,
      errors: state.filter((x) => x.status === "error").length,
      mine: open.filter((x) => itemOwner(x) === role).length,
      open: open.length,
      resolved: done.filter((x) => RESOLVED.has(x.workflow)).length,
      clean: done.filter((x) => x.workflow === "clean").length,
      critical: open.filter((x) => topSeverity(x) === "CRITICAL").length,
    };
  }

  function renderStats(c) {
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
    const roleName = role === "coder" ? "coder" : "admin";
    els.stats.innerHTML = `
      <div class="stat"><div class="label">Audited</div><div class="value">${c.done}<span class="sub"> / ${c.total}</span></div>
        <div class="progress"><span style="width:${pct}%"></span></div></div>
      <div class="stat"><div class="label">Waiting on ${roleName}</div><div class="value">${c.mine}</div><div class="sub">in your queue</div></div>
      <div class="stat"><div class="label">Open issues</div><div class="value">${c.open}</div><div class="sub">${c.critical} critical</div></div>
      <div class="stat"><div class="label">Ready to submit</div><div class="value">${c.clean}</div><div class="sub">passed audit</div></div>
      <div class="stat"><div class="label">Resolved</div><div class="value">${c.resolved}</div><div class="sub">${c.errors ? `${c.errors} failed to audit` : "fixed, sent back or overridden"}</div></div>`;
  }

  function renderTabs(c) {
    const defs = [["mine", "My queue", c.mine], ["open", "All open", c.open], ["resolved", "Resolved", c.resolved], ["all", "All", c.total]];
    els.tabs.innerHTML = defs.map(([id, label, n]) =>
      `<button class="tab" role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}<span class="count">${n}</span></button>`).join("");
  }

  function issuePills(it) {
    if (it.status === "queued") return `<span class="pill neutral">Queued</span>`;
    if (it.status === "auditing") return `<span class="pill neutral"><span class="spinner"></span>Auditing</span>`;
    if (it.status === "error") return `<span class="pill critical" title="${esc(it.error)}">Audit failed</span>`;
    const vs = it.report.violations || [];
    const out = [];
    const bySev = {};
    vs.forEach((v) => { const s = String(v.severity).toUpperCase(); bySev[s] = (bySev[s] || 0) + 1; });
    Object.keys(bySev).sort((a, b) => (SEV_RANK[a] ?? 9) - (SEV_RANK[b] ?? 9))
      .forEach((s) => out.push(`<span class="pill ${s.toLowerCase()}">${bySev[s]} ${s.toLowerCase()}</span>`));
    if (it.report.human_in_the_loop_required) out.push(`<span class="pill review">Human review</span>`);
    if (!out.length) out.push(`<span class="pill ok">No issues</span>`);
    return `<div class="pill-row">${out.join("")}</div>`;
  }

  function ownerPill(it) {
    if (it.status !== "done" || RESOLVED.has(it.workflow)) return `<span class="codes">—</span>`;
    const o = itemOwner(it);
    return o === "coder" ? `<span class="pill info">Coder</span>` : o === "admin" ? `<span class="pill neutral">Admin</span>` : `<span class="codes">—</span>`;
  }

  function statusPill(it) {
    if (it.status !== "done") return `<span class="codes">—</span>`;
    const w = WORKFLOW[it.workflow] || WORKFLOW.open;
    return `<span class="pill ${w.cls}">${w.label}</span>`;
  }

  function renderRows() {
    const items = visibleItems();
    els.empty.hidden = state.length > 0;
    if (state.length && !items.length) {
      els.rows.innerHTML = `<tr><td colspan="6" class="codes" style="text-align:center;padding:24px">Nothing here. ${tab === "mine" ? "Your queue is clear." : ""}</td></tr>`;
      return;
    }
    els.rows.innerHTML = items.map((it) => {
      const r = it.record;
      return `<tr data-key="${it.key}" tabindex="0" class="${it.key === selected ? "selected" : ""}">
        <td><div class="rid">${esc(r.record_id)}</div><div class="date">${esc(r.encounter_date)}</div></td>
        <td>${esc(r.department)}</td>
        <td class="codes">ICD ${esc((r.icd10_codes || []).join(", ") || "—")}<br>CPT ${esc((r.cpt_codes || []).join(", ") || "—")}</td>
        <td>${issuePills(it)}</td>
        <td>${ownerPill(it)}</td>
        <td>${statusPill(it)}</td>
      </tr>`;
    }).join("");
  }

  function renderDetail() {
    const it = state.find((x) => x.key === selected);
    if (!it) {
      els.detail.innerHTML = `<div class="detail-empty"><p>Select a record to review its findings.</p></div>`;
      return;
    }
    const r = it.record;
    const rep = it.report;
    const head = `
      <div class="detail-head">
        <h2>${esc(r.record_id)}</h2>
        <div class="meta">${esc(r.department)} · ${esc(r.encounter_date)} · ${esc(r.provider_id)}</div>
        <div class="pill-row">${statusPill(it)} ${ownerPill(it)} ${rep ? `<span class="pill neutral">Confidence ${Math.round(rep.confidence_score * 100)}%</span>` : ""}</div>
      </div>`;

    const facts = `
      <section>
        <h3>Record</h3>
        <dl class="facts">
          <dt>Patient ID</dt><dd>${esc(r.patient_id_hash)}</dd>
          <dt>ICD-10</dt><dd>${esc((r.icd10_codes || []).join(", ") || "—")}</dd>
          <dt>CPT</dt><dd>${esc((r.cpt_codes || []).join(", ") || "—")}</dd>
          <dt>Prior auth</dt><dd>${esc(r.prior_auth_token || "NONE")}</dd>
        </dl>
        <h3 style="margin-top:12px">Clinical notes</h3>
        <p class="notes">${esc(r.clinical_notes || "—")}</p>
      </section>`;

    let findings;
    if (it.status === "error") {
      findings = `<section><h3>Findings</h3><p>Audit failed: ${esc(it.error)}</p>
        <div class="actions"><button class="btn small" data-act="retry">Retry audit</button></div></section>`;
    } else if (!rep) {
      findings = `<section><h3>Findings</h3><p class="codes"><span class="spinner"></span> Audit in progress…</p></section>`;
    } else {
      const vs = [...(rep.violations || [])].sort((a, b) =>
        (SEV_RANK[String(a.severity).toUpperCase()] ?? 9) - (SEV_RANK[String(b.severity).toUpperCase()] ?? 9));
      const review = rep.human_in_the_loop_required
        ? `<div class="violation medium"><div class="violation-head"><strong>Needs human review</strong><span class="pill review">Coder</span></div>
           <p>The auditor's confidence is low (${Math.round(rep.confidence_score * 100)}%). Check the notes and codes before acting on the findings.</p>
           ${rep.engine_note ? `<p class="hint">${esc(rep.engine_note)}</p>` : ""}</div>` : "";
      findings = `<section><h3>Findings (${vs.length})</h3>${review}${vs.length ? vs.map((v) => {
        const sev = String(v.severity).toLowerCase();
        const own = violationOwner(v);
        return `<div class="violation ${esc(sev)}">
          <div class="violation-head">
            <span class="pill ${esc(sev)}">${esc(v.severity)}</span>
            <span class="rule">${esc(v.rule_id)}</span>
            <span class="pill ${own === "coder" ? "info" : "neutral"}">${own === "coder" ? "Coder review" : "Admin can resolve"}</span>
          </div>
          <p>${esc(v.description)}</p>
          <p class="evidence">${esc(v.evidence_quote)}</p>
          <p class="fix"><strong>Fix:</strong> ${esc(v.remediation_step)}</p>
        </div>`;
      }).join("") : `<p class="clean">✓ No compliance issues found.</p>`}</section>`;
    }

    const actions = rep && it.status === "done" ? `<section><h3>Actions</h3>${actionButtons(it)}</section>` : "";
    const history = `<section><h3>History</h3><ul class="history">${it.history.slice().reverse().map((h) =>
      `<li><time>${fmtTime(h.at)}</time><span><strong>${esc(h.who)}:</strong> ${esc(h.text)}</span></li>`).join("")}</ul></section>`;

    els.detail.innerHTML = head + findings + actions + facts + history;
  }

  function actionButtons(it) {
    if (RESOLVED.has(it.workflow)) {
      return `<div class="actions"><button class="btn small" data-act="reopen">Reopen</button></div>
        <p class="hint">${it.workflow === "clean" ? "This record passed the audit." : "This record is resolved."}</p>`;
    }
    const owner = itemOwner(it);
    if (role === "admin" && owner === "coder") {
      return `<div class="actions">
          <button class="btn small" data-act="provider">Send back to provider</button>
          ${it.workflow !== "escalated" ? `<button class="btn small primary" data-act="escalate">Escalate to coder</button>` : ""}
        </div>
        <p class="hint">This record has coding issues, so a coder needs to make the change. Admin staff can still send it back to the provider for documentation.</p>`;
    }
    return `<div class="actions">
        <button class="btn small primary" data-act="fixed">Mark fixed</button>
        <button class="btn small" data-act="provider">Send back to provider</button>
        ${role === "coder" ? `<button class="btn small ghost" data-act="override">Override…</button>` : ""}
      </div>
      <p class="hint">${role === "coder" ? "Override only when you're sure the record can go out as-is; you'll be asked for a reason." : "Privacy and prior-auth fixes are yours to resolve."}</p>`;
  }

  function render() {
    const c = counts();
    renderStats(c);
    renderTabs(c);
    renderRows();
    renderDetail();
    els.exportBtn.disabled = !c.done;
    els.clear.disabled = !c.total;
    document.querySelectorAll(".role-switch button").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.role === role)));
  }

  // ---------- actions ----------
  function act(kind) {
    const it = state.find((x) => x.key === selected);
    if (!it) return;
    const id = it.record.record_id;
    switch (kind) {
      case "fixed": it.workflow = "fixed"; addHistory(it, "Marked fixed"); toast(`${id} marked fixed`); break;
      case "provider": it.workflow = "provider"; addHistory(it, "Sent back to provider for documentation"); toast(`${id} sent to provider`); break;
      case "escalate": it.workflow = "escalated"; addHistory(it, "Escalated to coder"); toast(`${id} escalated to coder`); break;
      case "reopen": it.workflow = "open"; addHistory(it, "Reopened"); break;
      case "retry": it.status = "queued"; it.error = null; save(); render(); pump(); return;
      case "override":
        els.reason.value = "";
        els.dialog.showModal();
        return;
    }
    save();
    render();
  }

  function exportCSV() {
    const cols = ["record_id", "department", "encounter_date", "icd10_codes", "cpt_codes", "status", "owner", "top_severity", "rules", "confidence", "last_action"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(",")];
    state.filter((x) => x.status === "done").forEach((it) => {
      const r = it.record, rep = it.report;
      const last = it.history[it.history.length - 1];
      lines.push([r.record_id, r.department, r.encounter_date, (r.icd10_codes || []).join(";"), (r.cpt_codes || []).join(";"),
        (WORKFLOW[it.workflow] || WORKFLOW.open).label, RESOLVED.has(it.workflow) ? "" : itemOwner(it) || "",
        topSeverity(it), (rep.violations || []).map((v) => v.rule_id).join(";"), rep.confidence_score,
        last ? `${last.who}: ${last.text}` : ""].map(q).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `complimed-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- events ----------
  els.file.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      const records = /\.csv$/i.test(f.name) ? parseCSV(text) : normalizeInput(JSON.parse(text));
      enqueue(records);
    } catch (err) {
      toast(`Couldn't read ${f.name}: ${err.message}`);
    }
  });

  els.sample.addEventListener("click", async () => {
    try {
      const res = await fetch("/sample-batch.json");
      enqueue(normalizeInput(await res.json()));
    } catch { toast("Couldn't load the sample batch."); }
  });

  els.exportBtn.addEventListener("click", exportCSV);
  els.clear.addEventListener("click", () => {
    if (!confirm("Remove every record from this browser's queue?")) return;
    state = []; selected = null; save(); render();
  });

  els.search.addEventListener("input", (e) => { query = e.target.value; renderRows(); });

  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });

  document.querySelector(".role-switch").addEventListener("click", (e) => {
    const b = e.target.closest("[data-role]");
    if (!b) return;
    role = b.dataset.role;
    localStorage.setItem(ROLE_KEY, role);
    render();
  });

  function selectRow(tr) {
    if (!tr?.dataset.key) return;
    selected = tr.dataset.key;
    renderRows();
    renderDetail();
    if (window.matchMedia("(max-width: 1080px)").matches) els.detail.scrollIntoView({ behavior: "smooth" });
  }
  els.rows.addEventListener("click", (e) => selectRow(e.target.closest("tr")));
  els.rows.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRow(e.target.closest("tr")); }
  });

  els.detail.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b.dataset.act);
  });

  els.overrideCancel.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("submit", (e) => {
    const reason = els.reason.value.trim();
    if (!reason) { e.preventDefault(); return; }
    const it = state.find((x) => x.key === selected);
    if (it) {
      it.workflow = "overridden";
      addHistory(it, `Overrode findings: ${reason}`);
      save();
      render();
      toast(`${it.record.record_id} overridden`);
    }
  });

  // ---------- boot ----------
  render();
  pump();
})();
