const state = {
  candidates: [],
  rawText: "",
};

const els = {
  cards: document.getElementById("cards"),
  summary: document.getElementById("summary"),
  search: document.getElementById("searchInput"),
  category: document.getElementById("categoryFilter"),
  priority: document.getElementById("priorityFilter"),
  status: document.getElementById("statusFilter"),
  fileInput: document.getElementById("fileInput"),
  reloadBtn: document.getElementById("reloadBtn"),
  template: document.getElementById("cardTemplate"),
};

const CSV_FIELDS = [
  "name",
  "role",
  "company",
  "source_url",
  "reason_they_fit",
  "category",
  "priority",
  "approval_status",
  "suggested_message",
];

function parseCSV(text) {
  const rows = [];
  let current = [""];
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current[current.length - 1] += '"';
        i += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      current[current.length - 1] += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === ',') {
      current.push("");
      i += 1;
      continue;
    }

    if (char === '\n') {
      rows.push(current);
      current = [""];
      i += 1;
      continue;
    }

    if (char === '\r') {
      i += 1;
      continue;
    }

    current[current.length - 1] += char;
    i += 1;
  }

  rows.push(current);
  const [header, ...dataRows] = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  return dataRows.map((row) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = row[idx] ?? "";
    });
    return obj;
  });
}

function matchesQuery(candidate, query) {
  if (!query) return true;
  const haystack = [candidate.name, candidate.role, candidate.company].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function matchesFilter(value, filterValue) {
  return filterValue === "all" || (value || "").toLowerCase() === filterValue;
}

function badgeClass(value) {
  return `badge ${String(value || "").toLowerCase().replace(/\s+/g, "-")}`;
}

function render() {
  const query = els.search.value.trim();
  const category = els.category.value;
  const priority = els.priority.value;
  const status = els.status.value;

  const filtered = state.candidates.filter((candidate) =>
    matchesQuery(candidate, query) &&
    matchesFilter(candidate.category, category) &&
    matchesFilter(candidate.priority, priority) &&
    matchesFilter(candidate.approval_status, status)
  );

  els.summary.textContent = `${filtered.length} shown / ${state.candidates.length} total`;
  els.cards.innerHTML = "";

  filtered.forEach((candidate) => {
    const node = els.template.content.cloneNode(true);
    const article = node.querySelector(".candidate");
    node.querySelector(".name").textContent = candidate.name || "Unnamed";
    node.querySelector(".role-company").textContent = [candidate.role, candidate.company].filter(Boolean).join(" · ");
    node.querySelector(".reason").textContent = candidate.reason_they_fit || "";

    const sourceLink = node.querySelector(".source a");
    sourceLink.href = candidate.source_url || "#";
    sourceLink.textContent = candidate.source_url || "Source";

    const categoryBadge = node.querySelector(".category");
    categoryBadge.textContent = candidate.category || "uncategorized";
    categoryBadge.className = badgeClass(candidate.category);

    const priorityBadge = node.querySelector(".priority");
    priorityBadge.textContent = candidate.priority || "unknown";
    priorityBadge.className = badgeClass(candidate.priority);

    const statusBadge = node.querySelector(".status");
    statusBadge.textContent = candidate.approval_status || "pending";
    statusBadge.className = badgeClass(candidate.approval_status);

    const message = node.querySelector(".message");
    message.textContent = candidate.suggested_message || "No message yet.";

    const details = node.querySelector("details");
    details.addEventListener("toggle", () => {
      if (details.open) article.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    node.querySelector(".copy-btn").addEventListener("click", async () => {
      const text = candidate.suggested_message || "";
      await navigator.clipboard.writeText(text);
      els.summary.textContent = `Copied message for ${candidate.name}.`;
      setTimeout(render, 700);
    });

    els.cards.appendChild(node);
  });
}

async function loadCSVText(text) {
  state.rawText = text;
  state.candidates = parseCSV(text).map((row) => ({ ...row }));
  render();
}

async function loadFromRelativePath() {
  const res = await fetch("./candidates.csv", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load candidates.csv (${res.status})`);
  await loadCSVText(await res.text());
}

els.search.addEventListener("input", render);
els.category.addEventListener("change", render);
els.priority.addEventListener("change", render);
els.status.addEventListener("change", render);
els.reloadBtn.addEventListener("click", loadFromRelativePath);
els.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await loadCSVText(await file.text());
});

loadFromRelativePath().catch(() => {
  els.summary.textContent = "Pick candidates.csv to load the review list.";
});
