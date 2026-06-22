const dataSources = [
  { type: "encrypted", url: "./data/latest.enc.json" },
  { type: "plain", url: "./data/latest.json" },
  { type: "plain", url: "./data/sample-orders.json" },
];

const adminActionsStorageKey = "ghn-dashboard-admin-actions-v1";
const aiInboxConfigStorageKey = "ghn-dashboard-ai-inbox-config-v1";
const aiInboxLastAutoSendSignatureKey = "ghn-dashboard-ai-inbox-last-auto-send-signature-v1";
const aiRequestQueueSchema = "tq-ghn-ai-request-queue/v1";

const state = {
  filter: "all",
  data: null,
  encryptedData: null,
  passphrase: "",
  adminActions: loadAdminActions(),
  isRefreshing: false,
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
const refreshButtonEl = document.querySelector("#refreshDashboard");
const refreshStatusEl = document.querySelector("#refreshStatus");
const pullRefreshIndicatorEl = document.querySelector("#pullRefreshIndicator");
const filterTabsEl = document.querySelector(".filter-tabs");
const aiQueuePanelEl = document.querySelector("#aiQueuePanel");
const aiQueueTitleEl = document.querySelector("#aiQueueTitle");
const aiQueueDescriptionEl = document.querySelector("#aiQueueDescription");
const sendAiQueueButtonEl = document.querySelector("#sendAiQueue");
const copyAiQueueButtonEl = document.querySelector("#copyAiQueue");
const downloadAiQueueButtonEl = document.querySelector("#downloadAiQueue");
const configureAiInboxButtonEl = document.querySelector("#configureAiInbox");
const aiQueueMessageEl = document.querySelector("#aiQueueMessage");

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

function getServerAiRequests(data) {
  const statusPayload = data?.ai_request_status || data?.aiRequestStatus || {};
  return Array.isArray(statusPayload.requests) ? statusPayload.requests : [];
}

function isServerAiDone(request) {
  return request?.status === "ai_done" || request?.execution_status === "success";
}

function timestampValue(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function fallbackDoneRequestForOrder(orderCode, action, byOrderCode) {
  const matched = byOrderCode.get(orderCode);
  if (!matched) {
    return null;
  }

  const actionTime = timestampValue(action.requestedAt || action.updatedAt);
  const doneTime = timestampValue(
    matched.execution_updated_at || matched.updated_at || matched.imported_at,
  );
  if (!actionTime || !doneTime || doneTime >= actionTime) {
    return matched;
  }
  return null;
}

function syncAdminActionsFromServer(data) {
  const requests = getServerAiRequests(data).filter(isServerAiDone);
  if (!requests.length) {
    return 0;
  }

  const byRequestId = new Map();
  const byOrderCode = new Map();
  for (const request of requests) {
    if (request.request_id) {
      byRequestId.set(request.request_id, request);
    }
    if (request.order_code) {
      const existing = byOrderCode.get(request.order_code);
      const existingTime = String(existing?.execution_updated_at || existing?.updated_at || "");
      const requestTime = String(request.execution_updated_at || request.updated_at || "");
      if (!existing || requestTime >= existingTime) {
        byOrderCode.set(request.order_code, request);
      }
    }
  }

  let changed = 0;
  for (const [orderCode, action] of Object.entries(state.adminActions)) {
    if (action.status !== "pending_ai") {
      continue;
    }

    const matched =
      (action.requestId ? byRequestId.get(action.requestId) : null) ||
      fallbackDoneRequestForOrder(orderCode, action, byOrderCode);
    if (!matched) {
      continue;
    }

    state.adminActions[orderCode] = {
      ...action,
      status: "ai_done",
      aiDoneAt: matched.execution_updated_at || matched.updated_at || new Date().toISOString(),
      executionStatus: matched.execution_status || "success",
      executionResults: matched.execution_results || [],
      updatedAt: new Date().toISOString(),
    };
    changed += 1;
  }

  if (changed) {
    localStorage.setItem(adminActionsStorageKey, JSON.stringify(state.adminActions));
  }
  return changed;
}

function normalizeAiInboxConfig(config) {
  return {
    url: String(config?.url || "").trim(),
    key: String(config?.key || "").trim(),
  };
}

function getEmbeddedAiInboxConfig() {
  return normalizeAiInboxConfig(state.data?.ai_inbox || state.data?.aiInbox || {});
}

function loadAiInboxConfig() {
  try {
    const localConfig = normalizeAiInboxConfig(
      JSON.parse(localStorage.getItem(aiInboxConfigStorageKey)) || {},
    );
    if (localConfig.url && localConfig.key) {
      return localConfig;
    }
  } catch {
    // Fall back to the encrypted dashboard payload after unlock.
  }
  return getEmbeddedAiInboxConfig();
}

function saveAiInboxConfig(config) {
  const cleanConfig = normalizeAiInboxConfig(config);
  localStorage.setItem(aiInboxConfigStorageKey, JSON.stringify(cleanConfig));
  return cleanConfig;
}

function hasAiInboxConfig() {
  const config = loadAiInboxConfig();
  return Boolean(config.url && config.key);
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

function suggestedAiAction(result) {
  const actions = {
    customer_confirm_receive: "redeliver",
    shipper_did_not_call: "complain_driver_and_redeliver",
    info_correct_redeliver: "redeliver",
    wrong_address_new_address: "update_address_and_redeliver",
    wrong_phone_new_phone: "update_phone_and_redeliver",
    customer_schedule_redeliver: "schedule_redelivery",
    customer_refuse: "review_customer_refusal",
    shop_no_answer: "wait_for_admin",
    phone_unreachable_blocked: "review_contact_info",
    manual_done: "audit_manual_resolution",
  };
  return actions[result] || "review";
}

function buildAiRequest(order, action) {
  const requestedAt = action.requestedAt || action.updatedAt || new Date().toISOString();
  return {
    request_id: action.requestId || `${order.order_code}-${requestedAt.replace(/[^\d]/g, "")}`,
    order_code: order.order_code,
    status: action.status || "pending_ai",
    requested_at: requestedAt,
    updated_at: action.updatedAt || requestedAt,
    admin_result: action.result || "",
    admin_result_label: action.resultLabel || "",
    admin_note: action.note || "",
    suggested_ai_action: suggestedAiAction(action.result),
    order_snapshot: {
      order_code: order.order_code,
      bucket: order.bucket || "",
      current_status: order.current_status || "",
      priority: order.priority || "",
      customer_name: order.customer_name || "",
      customer_phone: cleanPhone(order.customer_phone),
      driver_name: order.driver_name || "",
      driver_phone: cleanPhone(order.driver_phone),
      latest_reason: order.latest_reason || "",
      fail_count: Number(order.fail_count || 0),
      recommended_action: order.recommended_action || "",
    },
  };
}

function getAiQueueRequests() {
  const orders = Array.isArray(state.data?.orders) ? state.data.orders : [];
  return orders
    .map((order) => {
      const action = getAdminAction(order);
      return action.status === "pending_ai" ? buildAiRequest(order, action) : null;
    })
    .filter(Boolean)
    .sort((left, right) => String(left.requested_at).localeCompare(String(right.requested_at)));
}

function buildAiQueuePayload() {
  return {
    schema: aiRequestQueueSchema,
    exported_at: new Date().toISOString(),
    dashboard_generated_at: state.data?.generated_at || null,
    request_count: getAiQueueRequests().length,
    requests: getAiQueueRequests(),
  };
}

function aiQueueSignature(payload) {
  return payload.requests
    .map((request) => `${request.request_id}:${request.updated_at}:${request.status}`)
    .join("|");
}

async function maybeAutoSendAiQueue() {
  const payload = buildAiQueuePayload();
  if (!payload.request_count || !hasAiInboxConfig()) {
    return;
  }

  const signature = aiQueueSignature(payload);
  if (!signature || localStorage.getItem(aiInboxLastAutoSendSignatureKey) === signature) {
    return;
  }

  const sent = await sendAiQueueToInbox({ quiet: true });
  if (sent) {
    localStorage.setItem(aiInboxLastAutoSendSignatureKey, signature);
  }
}

function formatAiQueueForClipboard(payload) {
  return [
    "YÊU CẦU AI XỬ LÝ VẬN ĐƠN GHN",
    `Số yêu cầu: ${payload.request_count}`,
    `Xuất lúc: ${payload.exported_at}`,
    "",
    "AI đọc JSON bên dưới và xử lý từng yêu cầu theo admin_result, admin_note và suggested_ai_action.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setQueueMessage(message, isError = false) {
  aiQueueMessageEl.textContent = message;
  aiQueueMessageEl.classList.toggle("is-error", isError);
}

async function sendAiQueueToInbox({ quiet = false } = {}) {
  const payload = buildAiQueuePayload();
  if (!payload.request_count) {
    if (!quiet) {
      setQueueMessage("Chưa có yêu cầu AI nào để gửi inbox.", true);
    }
    return false;
  }

  const config = loadAiInboxConfig();
  if (!config.url || !config.key) {
    if (!quiet) {
      setQueueMessage("Chưa cấu hình inbox. Bấm Cấu hình inbox để nhập Web App URL và key.", true);
    }
    return false;
  }

  const body = {
    inbox_key: config.key,
    source: "ghn-dashboard-pwa",
    payload,
  };

  try {
    await fetch(config.url, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    localStorage.setItem("ghn-dashboard-ai-inbox-last-send-at", new Date().toISOString());
    setQueueMessage(`Đã gửi ${payload.request_count} yêu cầu sang inbox.`);
    return true;
  } catch {
    if (!quiet) {
      setQueueMessage("Chưa gửi được inbox. Kiểm tra mạng hoặc Web App URL.", true);
    }
    return false;
  }
}

function renderAiQueuePanel() {
  const payload = buildAiQueuePayload();
  const hasRequests = payload.request_count > 0;
  const inboxConfigured = hasAiInboxConfig();

  aiQueueTitleEl.textContent = hasRequests
    ? `${payload.request_count} yêu cầu đang chờ AI`
    : "Chưa có yêu cầu AI";
  aiQueueDescriptionEl.textContent = hasRequests
    ? inboxConfigured
      ? "Inbox đã cấu hình. Dashboard sẽ gửi queue lên Google Sheet khi admin yêu cầu AI xử lý."
      : "Chưa cấu hình inbox tự động. Có thể copy/tải thủ công hoặc bấm Cấu hình inbox."
    : "Các đơn admin bấm yêu cầu AI xử lý sẽ nằm ở đây để copy/tải/gửi inbox cho AI.";
  sendAiQueueButtonEl.disabled = !hasRequests || !inboxConfigured;
  copyAiQueueButtonEl.disabled = !hasRequests;
  downloadAiQueueButtonEl.disabled = !hasRequests;
  setQueueMessage("");
}

function priorityClass(priority) {
  return priority === "Cao" ? "high" : "medium";
}

function setDashboardVisible(isVisible) {
  summaryEl.hidden = !isVisible;
  filterTabsEl.hidden = !isVisible;
  cardsEl.hidden = !isVisible;
  aiQueuePanelEl.hidden = true;
}

function setRefreshStatus(message, isError = false) {
  refreshStatusEl.textContent = message;
  refreshStatusEl.classList.toggle("is-error", isError);
}

function setRefreshBusy(isBusy) {
  state.isRefreshing = isBusy;
  refreshButtonEl.disabled = isBusy;
  refreshButtonEl.textContent = isBusy ? "Đang..." : "Làm mới";
}

async function refreshDashboard() {
  if (state.isRefreshing) {
    return false;
  }

  setRefreshBusy(true);
  setRefreshStatus("Đang làm mới dữ liệu...");

  try {
    const loaded = await loadData();
    if (loaded.encrypted) {
      state.encryptedData = loaded.payload;
      if (!state.passphrase) {
        showUnlock(loaded.payload);
        setRefreshStatus("Nhập mật khẩu để mở dữ liệu mới.");
        return true;
      }

      const data = await decryptDashboardData(loaded.payload, state.passphrase);
      showDashboard(data);
    } else {
      showDashboard(loaded.payload);
    }

    const refreshedAt = new Date().toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    setRefreshStatus(`Đã làm mới lúc ${refreshedAt}.`);
    return true;
  } catch {
    setRefreshStatus("Chưa làm mới được. Kiểm tra mạng rồi thử lại.", true);
    return false;
  } finally {
    setRefreshBusy(false);
  }
}

function setPullRefreshIndicator(message, { visible = true, ready = false } = {}) {
  pullRefreshIndicatorEl.textContent = message;
  pullRefreshIndicatorEl.hidden = !visible;
  pullRefreshIndicatorEl.classList.toggle("is-visible", visible);
  pullRefreshIndicatorEl.classList.toggle("is-ready", ready);
}

function hidePullRefreshIndicator() {
  pullRefreshIndicatorEl.classList.remove("is-visible", "is-ready");
  setTimeout(() => {
    if (!pullRefreshIndicatorEl.classList.contains("is-visible")) {
      pullRefreshIndicatorEl.hidden = true;
    }
  }, 180);
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest("a, button, input, select, textarea"));
}

function bindPullToRefresh() {
  const threshold = 86;
  const pullState = {
    active: false,
    startY: 0,
    distance: 0,
  };

  document.addEventListener(
    "touchstart",
    (event) => {
      if (
        event.touches.length !== 1 ||
        window.scrollY > 0 ||
        state.isRefreshing ||
        isInteractiveTarget(event.target)
      ) {
        return;
      }

      pullState.active = true;
      pullState.startY = event.touches[0].clientY;
      pullState.distance = 0;
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!pullState.active || event.touches.length !== 1) {
        return;
      }

      const distance = event.touches[0].clientY - pullState.startY;
      if (distance <= 0 || window.scrollY > 0) {
        pullState.active = false;
        hidePullRefreshIndicator();
        return;
      }

      pullState.distance = Math.min(distance, 140);
      if (pullState.distance > 24) {
        event.preventDefault();
        setPullRefreshIndicator(
          pullState.distance >= threshold ? "Thả tay để làm mới" : "Kéo xuống để làm mới",
          {
            visible: true,
            ready: pullState.distance >= threshold,
          },
        );
      }
    },
    { passive: false },
  );

  document.addEventListener(
    "touchend",
    () => {
      if (!pullState.active) {
        return;
      }

      const shouldRefresh = pullState.distance >= threshold;
      pullState.active = false;
      pullState.distance = 0;

      if (!shouldRefresh) {
        hidePullRefreshIndicator();
        return;
      }

      setPullRefreshIndicator("Đang làm mới...", { visible: true, ready: true });
      void refreshDashboard().finally(() => {
        setTimeout(hidePullRefreshIndicator, 650);
      });
    },
    { passive: true },
  );
}

function bindRefresh() {
  refreshButtonEl.addEventListener("click", () => {
    void refreshDashboard();
  });
  bindPullToRefresh();
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
  syncAdminActionsFromServer(state.data);
  unlockPanelEl.hidden = true;
  setDashboardVisible(true);
  syncTimeEl.textContent = `Cập nhật: ${state.data.generated_at || "dữ liệu mẫu"}`;
  renderSummary(state.data);
  renderAiQueuePanel();
  renderCards();
  void maybeAutoSendAiQueue();
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

    async function markOrderForAi() {
      const selectedOption = resultSelect.selectedOptions[0];
      const resultLabel = selectedOption?.textContent?.trim() || "";
      const noteRequired = selectedOption?.dataset.requiresNote === "true";
      const note = noteInput.value.trim();
      const requestedAt = new Date().toISOString();

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
        requestId: `${order.order_code}-${requestedAt.replace(/[^\d]/g, "")}`,
        requestedAt,
        result: resultSelect.value,
        resultLabel,
        note,
        status: "pending_ai",
      });
      renderSummary(state.data);
      renderAiQueuePanel();
      if (state.filter === "all") {
        refreshActionUi();
        noteHint.textContent = `Đã gửi yêu cầu AI xử lý: ${resultLabel}.`;
        noteHint.classList.add("is-ok");
      } else {
        renderCards();
      }
      if (hasAiInboxConfig()) {
        await sendAiQueueToInbox({ quiet: true });
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

function bindAiQueue() {
  sendAiQueueButtonEl.addEventListener("click", () => {
    sendAiQueueToInbox();
  });

  copyAiQueueButtonEl.addEventListener("click", async () => {
    const payload = buildAiQueuePayload();
    if (!payload.request_count) {
      setQueueMessage("Chưa có yêu cầu AI nào để copy.", true);
      return;
    }

    try {
      await copyText(formatAiQueueForClipboard(payload));
      setQueueMessage(`Đã copy ${payload.request_count} yêu cầu AI.`);
    } catch {
      setQueueMessage("Chưa copy được gói yêu cầu. Thử nút tải file JSON.", true);
    }
  });

  downloadAiQueueButtonEl.addEventListener("click", () => {
    const payload = buildAiQueuePayload();
    if (!payload.request_count) {
      setQueueMessage("Chưa có yêu cầu AI nào để tải.", true);
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`ghn-ai-requests-${stamp}.json`, `${JSON.stringify(payload, null, 2)}\n`);
    setQueueMessage(`Đã tạo file ${payload.request_count} yêu cầu AI.`);
  });

  configureAiInboxButtonEl.addEventListener("click", () => {
    const current = loadAiInboxConfig();
    const url = prompt("Dán Google Apps Script Web App URL:", current.url || "");
    if (url === null) {
      return;
    }
    const key = prompt("Dán inbox key:", current.key || "");
    if (key === null) {
      return;
    }

    const saved = saveAiInboxConfig({ url, key });
    renderAiQueuePanel();
    if (saved.url && saved.key) {
      setQueueMessage("Đã lưu cấu hình inbox trên thiết bị này.");
    } else {
      setQueueMessage("Inbox chưa đủ URL/key.", true);
    }
  });
}

function bindUnlock() {
  unlockFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    unlockMessageEl.textContent = "Đang mở dữ liệu...";
    try {
      const passphrase = passwordInputEl.value;
      const data = await decryptDashboardData(state.encryptedData, passphrase);
      state.passphrase = passphrase;
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
  bindAiQueue();
  bindRefresh();
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
