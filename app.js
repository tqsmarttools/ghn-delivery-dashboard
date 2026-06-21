const dataSources = ["./data/latest.json", "./data/sample-orders.json"];
const state = {
  filter: "all",
  data: null,
};

const summaryEl = document.querySelector("#summary");
const cardsEl = document.querySelector("#cards");
const syncTimeEl = document.querySelector("#syncTime");
const template = document.querySelector("#orderCardTemplate");

async function loadData() {
  for (const source of dataSources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Try the next source. The committed app intentionally ships with sample data only.
    }
  }
  throw new Error("Không tải được dữ liệu dashboard.");
}

function phoneLink(phone) {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean ? `tel:${clean}` : "#";
}

function priorityClass(priority) {
  return priority === "Cao" ? "high" : "medium";
}

function renderSummary(data) {
  const summary = data.summary || {};
  const cards = [
    ["Cần chú ý", summary.current_needs_action_count ?? data.orders.length],
    ["Cần xử lý", summary.bucket_counts?.CAN_XU_LY ?? 0],
    ["Chờ hoàn", summary.bucket_counts?.CHO_HOAN ?? 0],
  ];

  summaryEl.innerHTML = cards
    .map(([label, value]) => `
      <div class="summary-card">
        <strong>${value}</strong>
        <span>${label}</span>
      </div>
    `)
    .join("");
}

function renderCards() {
  const orders = state.data.orders.filter((order) => {
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
    node.querySelector(".customer").textContent = `${order.customer_name} - ${order.customer_phone}`;
    node.querySelector(".customer-call").href = phoneLink(order.customer_phone);
    node.querySelector(".shipper-call").href = phoneLink(order.driver_phone);
    node.querySelector(".reason").textContent = order.latest_reason || "Chưa có lý do";
    node.querySelector(".fail-count").textContent = `${order.fail_count || 0} lần`;
    node.querySelector(".shipper").textContent = `${order.driver_name || "Chưa có"} - ${order.driver_phone || ""}`;
    node.querySelector(".recommendation").textContent = order.recommended_action || "Shop kiểm tra thêm.";
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

async function init() {
  bindFilters();
  state.data = await loadData();
  syncTimeEl.textContent = `Cập nhật: ${state.data.generated_at || "dữ liệu mẫu"}`;
  renderSummary(state.data);
  renderCards();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init().catch((error) => {
  syncTimeEl.textContent = error.message;
});

