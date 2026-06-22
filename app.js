const dataSources = [
  { type: "encrypted", url: "./data/latest.enc.json" },
  { type: "plain", url: "./data/latest.json" },
  { type: "plain", url: "./data/sample-orders.json" },
];

const adminActionsStorageKey = "ghn-dashboard-admin-actions-v1";

const state = {
  filter: "all",
  data: null,
  encryptedData: null,
  adminActions: loadAdminActions(),
};

const noteGuidanceByResult = {
  shipper_did_not_call: "Cần ghi chú khách xác nhận thế nào, ví dụ: khách nói không có cuộc gọi nhỡ.",
  info_correct_redeliver: "Cần ghi chú ngắn: khách xác nhận SĐT/địa chỉ đúng, nếu có giờ giao thì ghi thêm.",
  wrong_address_new_address: "Cần ghi địa chỉ mới đầy đủ: ấp/xã/huyện/tỉnh và ghi chú đường đi nếu có.",
  wrong_phone_new_phone: "Cần ghi SĐT mới, tên người nhận nếu đổi người nhận.",
  customer_schedule_redeliver: "Cần ghi ngày/giờ khách hẹn giao lại, ví dụ: giao sau 17h hôm nay.",
  phone_unreachable_blocked: "Nếu shop có số phụ hoặc thông tin khác thì ghi vào đây.",
  manual_done: "Cần ghi shop đã xử lý gì: đã gọi GHN, đã sửa đơn, đã hủy hoặc đã báo khách.",
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

function loadAdminActions() {
  try {
    return JSON.parse(localStorage.getItem(adminActionsStorageKey)) || {};
  } catch {
    return {};
  }
}

function saveAdminAction(orderCode, action) {
  state.adminActions[orderCode] = {
    ...(state.adminActions[orderCode] || {}),
    ...action,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(adminActionsStorageKey, JSON.stringify(state.adminActions));
}

function getAdminAction(order) {
  return state.adminActions[order.order_code] || {};
}

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

function cleanPhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function sentence(value, fallback) {
  const clean = String(value || "").trim() || fallback;
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function buildCustomerMessage(order) {
  const failCount = Number(order.fail_count || 0) || 1;
  const reason = sentence(order.latest_reason, "Chưa có lý do");
  const driverName = order.driver_name || "Chưa có thông tin";
  const driverPhone = cleanPhone(order.driver_phone);
  const shipper = sentence(`${driverName}${driverPhone ? ` - ${driverPhone}` : ""}`, "Chưa có thông tin");

  return [
    `GIAO HÀNG THẤT BẠI - LẦN ${failCount}!`,
    "",
    `Lý do shipper báo: ${reason}`,
    `Shipper: ${shipper}`,
    "",
    "Anh kiểm tra lại giúp shop thông tin trên có đúng không ạ?",
  ].join("\n");
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
  const countByFilter = (filter) => orders.filter((order) => orderMatchesFilter(order, filter)).length;
  const cards = [
    ["Cần chú ý", summary.current_needs_action_count ?? orders.length],
    ["Cần xử lý", countByFilter("CAN_XU_LY")],
    ["Chờ AI", countByFilter("CHO_AI")],
    ["AI đã xử lý", countByFilter("AI_DA_XU_LY")],
    ["Chờ hoàn", countByFilter("CHO_HOAN")],
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

function orderMatchesFilter(order, filter = state.filter) {
  const actionStatus = getAdminAction(order).status;
  if (filter === "all") {
    return true;
  }
  if (filter === "CHO_AI") {
    return actionStatus === "pending_ai";
  }
  if (filter === "AI_DA_XU_LY") {
    return actionStatus === "ai_done";
  }
  if (actionStatus === "pending_ai" || actionStatus === "ai_done") {
    return false;
  }
  return order.bucket === filter;
}

function setFeedback(element, message, isOk = true) {
  element.textContent = message;
  element.classList.toggle("is-ok", isOk);
}

function renderCards() {
  const orders = (state.data.orders || []).filter((order) => {
    return orderMatchesFilter(order);
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
    node.querySelector(".customer-name").textContent = order.customer_name || "Khách";
    node.querySelector(".customer-call").href = phoneLink(order.customer_phone);
    node.querySelector(".shipper-call").href = phoneLink(order.driver_phone);
    node.querySelector(".reason").textContent = order.latest_reason || "Chưa có lý do";
    node.querySelector(".fail-count").textContent = `${order.fail_count || 0} lần`;
    node.querySelector(".shipper").textContent =
      `${order.driver_name || "Chưa có"} - ${order.driver_phone || ""}`;
    node.querySelector(".recommendation").textContent =
      order.recommended_action || "Shop kiểm tra thêm.";

    const savedAction = getAdminAction(order);
    const card = node.querySelector(".order-card");
    const feedback = node.querySelector(".card-feedback");
    const copyPhoneButton = node.querySelector(".copy-phone");
    const copyMessageButton = node.querySelector(".copy-message-button");
    const resultSelect = node.querySelector(".admin-result");
    const noteInput = node.querySelector(".admin-note");
    const noteHint = node.querySelector(".admin-note-hint");
    const submitButton = node.querySelector(".submit-button");
    const customerPhone = cleanPhone(order.customer_phone);

    copyPhoneButton.textContent = customerPhone ? `${customerPhone} · bấm để copy` : "Chưa có SĐT";
    copyPhoneButton.disabled = !customerPhone;
    copyPhoneButton.addEventListener("click", async () => {
      try {
        await copyText(customerPhone);
        setFeedback(feedback, "Đã copy SĐT khách.");
      } catch {
        setFeedback(feedback, "Chưa copy được SĐT. Admin copy thủ công giúp em.", false);
      }
    });

    copyMessageButton.addEventListener("click", async () => {
      try {
        await copyText(buildCustomerMessage(order));
        setFeedback(feedback, "Đã copy tin nhắn gửi khách.");
      } catch {
        setFeedback(feedback, "Chưa copy được tin nhắn. Admin copy thủ công giúp em.", false);
      }
    });

    if (savedAction.result) {
      resultSelect.value = savedAction.result;
    }
    if (savedAction.note) {
      noteInput.value = savedAction.note;
    }

    function refreshActionUi() {
      const actionStatus = getAdminAction(order).status;
      card.dataset.aiStatus = actionStatus || "";
      submitButton.disabled = false;
      if (actionStatus === "pending_ai") {
        submitButton.textContent = "Đã gửi yêu cầu AI xử lý";
        noteHint.textContent = "Đơn đang nằm trong mục Chờ AI.";
        noteHint.classList.add("is-ok");
      } else if (actionStatus === "ai_done") {
        submitButton.textContent = "AI đã xử lý xong";
        submitButton.disabled = true;
        noteHint.textContent = "Đơn đang nằm trong mục AI đã xử lý.";
        noteHint.classList.add("is-ok");
      } else {
        submitButton.textContent = "Yêu cầu AI xử lý";
      }
    }

    function markOrderForAi() {
      const selectedOption = resultSelect.selectedOptions[0];
      const resultLabel = selectedOption?.textContent?.trim() || "";
      const noteRequired = selectedOption?.dataset.requiresNote === "true";
      const note = noteInput.value.trim();

      noteHint.classList.remove("is-ok");
      if (resultSelect.value === "not_called") {
        noteHint.textContent = "Chọn kết quả gọi khách trước khi yêu cầu AI xử lý.";
        resultSelect.focus();
        return;
      }

      if (noteRequired && !note) {
        noteHint.textContent =
          noteGuidanceByResult[resultSelect.value] || "Mục này cần nhập ghi chú admin.";
        noteInput.focus();
        return;
      }

      saveAdminAction(order.order_code, {
        result: resultSelect.value,
        resultLabel,
        note,
        status: "pending_ai",
      });
      renderSummary(state.data);
      if (state.filter === "all") {
        refreshActionUi();
        noteHint.textContent = `Đã gửi yêu cầu AI xử lý: ${resultLabel}.`;
        noteHint.classList.add("is-ok");
      } else {
        renderCards();
      }
    }

    resultSelect.addEventListener("change", () => {
      const selectedOption = resultSelect.selectedOptions[0];
      noteHint.classList.remove("is-ok");
      noteHint.textContent =
        selectedOption?.dataset.requiresNote === "true"
          ? noteGuidanceByResult[resultSelect.value] || "Mục này cần nhập ghi chú admin."
          : "";
    });

    submitButton.addEventListener("click", markOrderForAi);
    refreshActionUi();
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
