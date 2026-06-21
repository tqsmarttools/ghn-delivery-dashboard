const dataSources = [
  { type: "encrypted", url: "./data/latest.enc.json" },
  { type: "plain", url: "./data/latest.json" },
  { type: "plain", url: "./data/sample-orders.json" },
];

const state = {
  filter: "all",
  data: null,
  encryptedData: null,
};

const summaryEl = document.querySelector("#summary");
const cardsEl = document.querySelector("#cards");
const syncTimeEl = document.querySelector("#syncTime");
const template = document.querySelector("#orderCardTemplate");
const unlockPanelEl = document.querySelector("#unlockPanel");
const unlockFormEl = document.querySelector("#unlockForm");
const unlockMessageEl = document.querySelector("#unlockMessage");
const passwordInputEl = document.querySelector("#dashboardPassword");
const filterTabsEl = document.querySelector(".filter-tabs");

async function loadData() {
  for (const source of dataSources) {
    try {
      const response = await fetch(source.url, { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json();
        return { encrypted: source.type === "encrypted", payload };
      }
    } catch {
      // Try the next source. The committed app intentionally ships with sample data only.
    }
  }
  throw new Error("Không tải được dữ liệu dashboard.");
}

function base64UrlToBytes(value) {
  let base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left, right) {
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

async function decryptDashboardData(envelope, passphrase) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Trình duyệt này không hỗ trợ giải mã an toàn.");
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(envelope.salt),
      iterations: envelope.iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const tag = base64UrlToBytes(envelope.tag);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.iv),
    },
    key,
    concatBytes(ciphertext, tag),
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

function phoneLink(phone) {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean ? `tel:${clean}` : "#";
}

function priorityClass(priority) {
  return priority === "Cao" ? "high" : "medium";
}

function setDashboardVisible(isVisible) {
  summaryEl.hidden = !isVisible;
  filterTabsEl.hidden = !isVisible;
  cardsEl.hidden = !isVisible;
}

function showUnlock(envelope) {
  state.encryptedData = envelope;
  unlockPanelEl.hidden = false;
  setDashboardVisible(false);
  syncTimeEl.textContent = `Dữ liệu mã hóa: ${envelope.generated_at || "chưa rõ thời điểm"}`;
  passwordInputEl.focus();
}

function showDashboard(data) {
  state.data = data;
  unlockPanelEl.hidden = true;
  setDashboardVisible(true);
  syncTimeEl.textContent = `Cập nhật: ${state.data.generated_at || "dữ liệu mẫu"}`;
  renderSummary(state.data);
  renderCards();
}

function renderSummary(data) {
  const summary = data.summary || {};
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const cards = [
    ["Cần chú ý", summary.current_needs_action_count ?? orders.length],
    ["Cần xử lý", summary.bucket_counts?.CAN_XU_LY ?? 0],
    ["Chờ hoàn", summary.bucket_counts?.CHO_HOAN ?? 0],
  ];

  summaryEl.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="summary-card">
          <strong>${value}</strong>
          <span>${label}</span>
        </div>
      `,
    )
    .join("");
}

function renderCards() {
  const orders = (state.data.orders || []).filter((order) => {
    return state.filter === "all" || order.bucket === state.filter;
  });

  cardsEl.innerHTML = "";
  if (!orders.length) {
    cardsEl.innerHTML = '<p class="empty-state">Không có đơn trong nhóm này.</p>';
    return;
  }

  for (const order of orders) {
    const node = template.content.cloneNode(true);
    node.querySelector(".priority").textContent = order.priority || "Trung bình";
    node.querySelector(".priority").classList.add(priorityClass(order.priority));
    node.querySelector(".status").textContent = order.current_status || "unknown";
    node.querySelector(".order-code").textContent = order.order_code;
    node.querySelector(".customer").textContent =
      `${order.customer_name || "Khách"} - ${order.customer_phone || ""}`;
    node.querySelector(".customer-call").href = phoneLink(order.customer_phone);
    node.querySelector(".shipper-call").href = phoneLink(order.driver_phone);
    node.querySelector(".reason").textContent = order.latest_reason || "Chưa có lý do";
    node.querySelector(".fail-count").textContent = `${order.fail_count || 0} lần`;
    node.querySelector(".shipper").textContent =
      `${order.driver_name || "Chưa có"} - ${order.driver_phone || ""}`;
    node.querySelector(".recommendation").textContent =
      order.recommended_action || "Shop kiểm tra thêm.";
    node.querySelector(".submit-button").addEventListener("click", (event) => {
      const card = event.currentTarget.closest(".order-card");
      card.querySelector(".admin-result").value = "Cần AI xử lý";
    });
    cardsEl.appendChild(node);
  }
}

function bindFilters() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelector(".tab.is-active")?.classList.remove("is-active");
      tab.classList.add("is-active");
      state.filter = tab.dataset.filter;
      renderCards();
    });
  });
}

function bindUnlock() {
  unlockFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    unlockMessageEl.textContent = "Đang mở dữ liệu...";
    try {
      const passphrase = passwordInputEl.value;
      const data = await decryptDashboardData(state.encryptedData, passphrase);
      passwordInputEl.value = "";
      unlockMessageEl.textContent = "";
      showDashboard(data);
    } catch {
      unlockMessageEl.textContent = "Mật khẩu chưa đúng hoặc file dữ liệu bị lỗi.";
    }
  });
}

async function init() {
  bindFilters();
  bindUnlock();

  const loaded = await loadData();
  if (loaded.encrypted) {
    showUnlock(loaded.payload);
  } else {
    showDashboard(loaded.payload);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init().catch((error) => {
  syncTimeEl.textContent = error.message;
});
