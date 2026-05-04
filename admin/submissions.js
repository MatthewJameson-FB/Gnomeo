const ADMIN_PASSWORD = "gnomeo-admin";
const STORAGE_KEY = "gnomeo-admin-unlocked";
const PASSWORD_KEY = "gnomeo-admin-password";

const els = {
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gateForm"),
  gateInput: document.getElementById("gateInput"),
  gateError: document.getElementById("gateError"),
  app: document.getElementById("app"),
  list: document.getElementById("list"),
  stats: document.getElementById("stats"),
  reloadBtn: document.getElementById("reloadBtn"),
  template: document.getElementById("submissionTemplate"),
};

const state = { submissions: [] };

function unlock() {
  document.body.classList.remove("locked");
  els.gate.classList.add("hidden");
  els.app.classList.remove("hidden");
  sessionStorage.setItem(STORAGE_KEY, "1");
  sessionStorage.setItem(PASSWORD_KEY, ADMIN_PASSWORD);
  els.gateError.textContent = "";
}

function lockMessage(message) {
  els.gateError.textContent = message;
  els.gateInput.value = "";
  els.gateInput.focus();
}

function badgeClass(status) {
  return `badge status ${String(status || "received").toLowerCase()}`;
}

function formatDate(value) {
  if (!value) return "Not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function renderStats() {
  const counts = state.submissions.reduce((acc, item) => {
    acc.total += 1;
    acc[item.status || "received"] = (acc[item.status || "received"] || 0) + 1;
    return acc;
  }, { total: 0 });

  els.stats.innerHTML = [
    ["Total", counts.total],
    ["Received", counts.received || 0],
    ["Processing", counts.processing || 0],
    ["Report generated", counts.report_generated || 0],
    ["Failed", counts.failed || 0],
  ].map(([label, value]) => `<div class="stat"><span class="kicker">${label}</span><strong>${value}</strong></div>`).join("");
}

function render() {
  renderStats();
  els.list.innerHTML = "";

  if (!state.submissions.length) {
    els.list.innerHTML = '<div class="card submission-card"><p class="subtle">No submissions yet.</p></div>';
    return;
  }

  state.submissions.forEach((submission) => {
    const node = els.template.content.cloneNode(true);
    node.querySelector(".submission-id").textContent = submission.submission_id || "Unknown submission";
    node.querySelector(".filename").textContent = submission.original_filename || "Untitled file";
    node.querySelector(".meta-line").textContent = formatDate(submission.timestamp);
    node.querySelector(".status").textContent = submission.status || "received";
    node.querySelector(".status").className = badgeClass(submission.status);
    node.querySelector(".user-email").textContent = submission.user_email || "";
    node.querySelector(".original-filename").textContent = submission.original_filename || "";
    node.querySelector(".file-path").textContent = submission.uploaded_file_path || submission.saved_file_reference || "";
    node.querySelector(".notes").textContent = submission.notes || "";
    node.querySelector(".command").textContent = `python3 agent_mvp/agent_test.py --graph ${submission.uploaded_file_path || submission.saved_file_reference || "<file_path>"} --output-html report.html`;
    els.list.appendChild(node);
  });
}

async function loadSubmissions() {
  const res = await fetch("/api/admin/submissions", {
    cache: "no-store",
    headers: {
      "x-admin-password": sessionStorage.getItem(PASSWORD_KEY) || "",
    },
  });
  if (!res.ok) throw new Error(`Failed to load submissions (${res.status})`);
  const data = await res.json();
  state.submissions = Array.isArray(data.submissions) ? data.submissions : [];
  render();
}

function startApp() {
  document.body.classList.add("locked");
  els.app.classList.add("hidden");
  els.gate.classList.remove("hidden");

  const open = () => {
    unlock();
    loadSubmissions().catch((error) => {
      els.list.innerHTML = `<div class="card submission-card"><p class="subtle">${error.message}</p></div>`;
    });
  };

  if (sessionStorage.getItem(STORAGE_KEY) === "1") {
    open();
    return;
  }

  els.gateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (els.gateInput.value === ADMIN_PASSWORD) {
      open();
    } else {
      lockMessage("Wrong password.");
    }
  });
}

els.reloadBtn.addEventListener("click", () => {
  loadSubmissions().catch((error) => {
    els.list.innerHTML = `<div class="card submission-card"><p class="subtle">${error.message}</p></div>`;
  });
});

startApp();
