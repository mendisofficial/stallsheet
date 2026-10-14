const historyStatus = document.querySelector("#history-status");
const status = document.querySelector("#status");
const confirmPanel = document.querySelector("#confirm-panel");
const confirmForm = document.querySelector("#confirm-form");
const sheetPanel = document.querySelector("#sheet-panel");
const sheet = document.querySelector("#sheet");
const trace = document.querySelector("#trace");
const predictNote = document.querySelector("#predict-note");

const weekend = document.querySelector("#weekend");
const nextSaturday = new Date();
nextSaturday.setDate(nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7 || 7));
weekend.value = nextSaturday.toISOString().slice(0, 10);

let runId = "";

document.querySelector("#load-demo").addEventListener("click", () => loadDemo());
document.querySelector("#csv-file").addEventListener("change", uploadCsv);
document.querySelector("#audio").addEventListener("change", transcribe);
document.querySelector("#desk").addEventListener("submit", buildSheet);

loadDemo(true);

async function loadDemo(silent = false) {
  historyStatus.textContent = "Loading twelve weekends of Hearth & Rye…";
  const response = await fetch("/api/demo", { method: "POST" });
  const body = await response.json();
  historyStatus.textContent = `${body.rows} sales loaded for ${body.marketId}.`;
  if (!silent) status.textContent = "Demo history replaced.";
}

async function uploadCsv(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const csv = await file.text();
  const response = await fetch("/api/sales", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketId: "hearth-and-rye", csv }),
  });
  const body = await response.json();
  historyStatus.textContent = response.ok
    ? `${body.rows} sales replaced from ${file.name}.`
    : body.error;
}

async function transcribe(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  status.textContent = "Transcribing…";
  const data = new FormData();
  data.set("file", file);
  const response = await fetch("/api/transcribe", { method: "POST", body: data });
  const body = await response.json();
  if (!response.ok) {
    status.textContent = body.error;
    return;
  }
  const box = document.querySelector("#constraint");
  box.value = box.value ? `${box.value.trim()} ${body.text}` : body.text;
  status.textContent = "Transcript added to the constraint.";
}

async function buildSheet(event) {
  event.preventDefault();
  status.textContent = "Forecasting…";
  sheetPanel.classList.add("hidden");
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      marketId: "hearth-and-rye",
      city: document.querySelector("#city").value,
      weekend: weekend.value,
      weather: document.querySelector("#weather").value,
      constraint: document.querySelector("#constraint").value,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    status.textContent = body.error;
    return;
  }
  if (body.status === "suspended") {
    runId = body.runId;
    renderConfirm(body.suspend);
    status.textContent = "Check the quantities, then print the sheet.";
    return;
  }
  showSheet(body);
}

function renderConfirm(suspend) {
  confirmPanel.classList.remove("hidden");
  predictNote.textContent = `${suspend.predictionNote} Source: ${suspend.source}.`;
  const rows = suspend.proposals
    .map(
      (proposal) => `<tr>
        <td>${escapeHtml(proposal.item)}</td>
        <td><input name="qty" data-item="${escapeHtml(proposal.item)}" type="number" min="0" value="${proposal.recommendedQty}" /></td>
        <td><input name="price" data-item="${escapeHtml(proposal.item)}" type="number" min="0.5" step="0.01" value="${(proposal.priceCents / 100).toFixed(2)}" /></td>
        <td>${(proposal.lowCents / 100).toFixed(2)}–${(proposal.highCents / 100).toFixed(2)}</td>
      </tr>`,
    )
    .join("");
  confirmForm.innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Make</th><th>Price</th><th>Band</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button type="submit">Print the sheet</button>`;
  confirmForm.onsubmit = confirmSheet;
}

async function confirmSheet(event) {
  event.preventDefault();
  status.textContent = "Writing the sheet…";
  const items = [...confirmForm.querySelectorAll("input[name=qty]")].map((input) => {
    const price = confirmForm.querySelector(`input[name=price][data-item="${CSS.escape(input.dataset.item)}"]`);
    return {
      item: input.dataset.item,
      qty: Number(input.value),
      priceCents: Math.round(Number(price.value) * 100),
    };
  });
  const response = await fetch(`/api/runs/${runId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const body = await response.json();
  if (!response.ok) {
    status.textContent = body.error;
    return;
  }
  showSheet(body);
}

function showSheet(body) {
  status.textContent = "Sheet ready.";
  sheetPanel.classList.remove("hidden");
  const data = body.sheet;
  const tags = data.priceTags
    .map(
      (tag) =>
        `<li><span>${escapeHtml(tag.item)}</span><strong>${escapeHtml(tag.line.split("—")[1] || tag.line)}</strong><span>Make ${tag.qty}</span></li>`,
    )
    .join("");
  const prep = data.prepList.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const similar = (data.similar || [])
    .map((item) => `<li>${escapeHtml(item.weekend)} (${escapeHtml(item.weather)}): ${escapeHtml(item.highlight)}</li>`)
    .join("");
  const events = (data.events || [])
    .map((item) => `<li>${escapeHtml(item.title)} — ${escapeHtml(item.venue)}</li>`)
    .join("");
  sheet.innerHTML = `
    <p>${escapeHtml(data.caption)}</p>
    <ul class="tags">${tags}</ul>
    <h3>Prep list</h3>
    <ul>${prep}</ul>
    <h3>Similar weekends</h3>
    <ul>${similar || "<li>None yet.</li>"}</ul>
    <h3>Nearby events</h3>
    <ul>${events || "<li>None looked up.</li>"}</ul>
    <p class="hint">Copy from ${escapeHtml(data.copySource)}. Prices from ${escapeHtml(data.source)}.</p>`;
  trace.textContent = JSON.stringify(body.trace, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
