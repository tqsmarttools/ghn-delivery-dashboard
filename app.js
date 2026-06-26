const dataSources = [
  { type: "encrypted", url: "./data/latest.enc.json" },
  { type: "plain", url: "./data/latest.json" },
  { type: "plain", url: "./data/sample-orders.json" },
];
const appShellVersion = "31";

const adminActionsStorageKey = "ghn-dashboard-admin-actions-v1";
const aiInboxConfigStorageKey = "ghn-dashboard-ai-inbox-config-v1";
const aiInboxLastAutoSendSignatureKey = "ghn-dashboard-ai-inbox-last-auto-send-signature-v1";
const dashboardSessionPassphraseKey = "ghn-dashboard-passphrase-session-v1";
const dashboardRememberedPassphraseKey = "ghn-dashboard-passphrase-device-v1";
const aiRequestQueueSchema = "tq-ghn-ai-request-queue/v1";

const state = {
  filter: "all",
  searchQuery: "",
  data: null,
  encryptedData: null,
  passphrase: loadRememberedPassphrase() || loadSessionPassphrase(),
  adminActions: loadAdminActions(),
  serverAiActions: new Map(),
  isRefreshing: false,
  dataLoadPromise: null,
};

const noteGuidanceByResult = {
  redeliver: "Có thể ghi ngắn: khách xác nhận vẫn nhận hàng, yêu cầu giao lại.",
  update_info_redeliver: "Cần ghi SĐT mới hoặc địa chỉ mới đầy đủ. Ví dụ: SĐT mới 09..., hoặc ấp/xã/huyện/tỉnh...",
  complain_driver_redeliver: "Cần ghi khách xác nhận thực tế thế nào, ví dụ: khách nói shipper không gọi nhưng báo không nghe máy.",
  schedule_note_redeliver: "Cần ghi ngày/giờ hoặc ghi chú giao hàng rõ ràng, ví dụ: giao sau 17h hôm nay, gọi trước 30 phút.",
  ignore_return: "AI sẽ không thao tác GHN; đơn này để shop cho hoàn/bỏ qua.",
  shipper_did_not_call: "Cần ghi chú khách xác nhận thế nào, ví dụ: khách nói không có cuộc gọi nhỡ.",
  info_correct_redeliver: "Cần ghi chú ngắn: khách xác nhận SĐT/địa chỉ đúng, nếu có giờ giao thì ghi thêm.",
  wrong_address_new_address: "Cần ghi địa chỉ mới đầy đủ: ấp/xã/huyện/tỉnh và ghi chú đường đi nếu có.",
  wrong_phone_new_phone: "Cần ghi SĐT mới, tên người nhận nếu đổi người nhận.",
  cod_new_amount: "Cần ghi COD mới bằng số rõ ràng, ví dụ: Hạ COD còn 180000.",
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
const searchPanelEl = document.querySelector("#searchPanel");
const searchInputEl = document.querySelector("#orderSearch");
const clearSearchButtonEl = document.querySelector("#clearSearch");
const searchMetaEl = document.querySelector("#searchMeta");
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

function loadSessionPassphrase() {
  try {
    return sessionStorage.getItem(dashboardSessionPassphraseKey) || "";
  } catch {
    return "";
  }
}

function loadRememberedPassphrase() {
  try {
    return localStorage.getItem(dashboardRememberedPassphraseKey) || "";
  } catch {
    return "";
  }
}

function saveSessionPassphrase(passphrase) {
  try {
    sessionStorage.setItem(dashboardSessionPassphraseKey, passphrase);
  } catch {
    // Keep the passphrase in memory only when sessionStorage is unavailable.
  }
}

function rememberPassphrase(passphrase) {
  saveSessionPassphrase(passphrase);
  try {
    localStorage.setItem(dashboardRememberedPassphraseKey, passphrase);
  } catch {
    // Fall back to the current session when persistent storage is unavailable.
  }
}

function clearSessionPassphrase() {
  try {
    sessionStorage.removeItem(dashboardSessionPassphraseKey);
  } catch {
    // Nothing to clear when sessionStorage is unavailable.
  }
}

function clearRememberedPassphrase() {
  clearSessionPassphrase();
  try {
    localStorage.removeItem(dashboardRememberedPassphraseKey);
  } catch {
    // Nothing to clear when persistent storage is unavailable.
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
  const localAction = currentActionForLatestFailure(order, state.adminActions[order.order_code] || {});
  const serverAction = currentActionForLatestFailure(order, state.serverAiActions.get(order.order_code));
  if (!serverAction) {
    return localAction;
  }

  if (!localAction.status) {
    return serverAction;
  }

  if (serverAction.status === "ai_done") {
    const localTime = timestampValue(localAction.requestedAt || localAction.updatedAt);
    const serverTime = timestampValue(serverAction.aiDoneAt || serverAction.updatedAt);
    if (
      localAction.status === "pending_ai" &&
      (!localTime || !serverTime || serverTime >= localTime || localAction.requestId === serverAction.requestId)
    ) {
      return {
        ...localAction,
        ...serverAction,
        status: "ai_done",
      };
    }
  }

  return localAction;
}

function getServerAiRequests(data) {
  const statusPayload = data?.ai_request_status || data?.aiRequestStatus || {};
  return Array.isArray(statusPayload.requests) ? statusPayload.requests : [];
}

function isServerAiDone(request) {
  return request?.status === "ai_done" || request?.execution_status === "success";
}

function isServerAiPending(request) {
  return request?.status === "pending_ai" && request?.execution_status !== "success";
}

function timestampValue(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestFailureTimestamp(order) {
  return timestampValue(order?.latest_fail_at || order?.latestFailAt);
}

function actionTimestampForLatestFailure(action) {
  if (!action?.status) {
    return 0;
  }
  if (action.status === "ai_done") {
    return timestampValue(action.aiDoneAt || action.updatedAt || action.requestedAt);
  }
  return timestampValue(action.requestedAt || action.updatedAt);
}

function actionHandlesLatestFailure(order, action) {
  if (!action?.status) {
    return false;
  }
  const failTime = latestFailureTimestamp(order);
  if (!failTime) {
    return true;
  }
  const actionTime = actionTimestampForLatestFailure(action);
  return Boolean(actionTime && actionTime >= failTime);
}

function currentActionForLatestFailure(order, action) {
  return actionHandlesLatestFailure(order, action) ? action : {};
}

function staleAiDoneActionForLatestFailure(order) {
  const candidates = [
    state.serverAiActions.get(order.order_code),
    state.adminActions[order.order_code],
  ];
  return (
    candidates.find((action) => action?.status === "ai_done" && !actionHandlesLatestFailure(order, action)) || null
  );
}

function aiHandledFailCount(order, action) {
  const handledCount = Number(action?.handledFailCount || action?.failCount || 0);
  const currentCount = Number(order?.fail_count || 0);
  if (handledCount > 0 && (!currentCount || handledCount < currentCount)) {
    return handledCount;
  }
  return currentCount > 1 ? currentCount - 1 : 0;
}

function repeatFailureAiNote(order) {
  const staleAction = staleAiDoneActionForLatestFailure(order);
  const handledCount = aiHandledFailCount(order, staleAction);
  return handledCount ? ` (AI đã xử lý lần ${handledCount})` : "";
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

function serverRequestTimestamp(request) {
  return timestampValue(
    request.execution_updated_at || request.updated_at || request.imported_at || request.requested_at,
  );
}

function actionFromServerRequest(request) {
  const status = isServerAiDone(request) ? "ai_done" : isServerAiPending(request) ? "pending_ai" : "";
  if (!status) {
    return null;
  }

  return {
    requestId: request.request_id || "",
    requestedAt: request.requested_at || null,
    updatedAt: request.updated_at || request.imported_at || null,
    status,
    aiDoneAt: request.execution_updated_at || request.updated_at || null,
    handledFailCount: Number(request.handled_fail_count || 0),
    handledLatestFailAt: request.handled_latest_fail_at || null,
    executionStatus: request.execution_status || "",
    executionResults: request.execution_results || [],
    serverSynced: true,
  };
}

function buildServerAiActions(data) {
  const byOrderCode = new Map();
  for (const request of getServerAiRequests(data)) {
    if (!request.order_code) {
      continue;
    }

    const action = actionFromServerRequest(request);
    if (!action) {
      continue;
    }

    const existing = byOrderCode.get(request.order_code);
    if (!existing || serverRequestTimestamp(request) >= existing.timestamp) {
      byOrderCode.set(request.order_code, {
        timestamp: serverRequestTimestamp(request),
        action,
      });
    }
  }

  return new Map(
    [...byOrderCode.entries()].map(([orderCode, value]) => [orderCode, value.action]),
  );
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

function loadStoredAiInboxConfig() {
  try {
    return normalizeAiInboxConfig(
      JSON.parse(localStorage.getItem(aiInboxConfigStorageKey)) || {},
    );
  } catch {
    return { url: "", key: "" };
  }
}

function loadAiInboxConfig() {
  const embeddedConfig = getEmbeddedAiInboxConfig();
  if (embeddedConfig.url && embeddedConfig.key) {
    try {
      const storedConfig = loadStoredAiInboxConfig();
      if (
        storedConfig.url &&
        (storedConfig.url !== embeddedConfig.url || storedConfig.key !== embeddedConfig.key)
      ) {
        localStorage.removeItem(aiInboxConfigStorageKey);
      }
    } catch {
      // Use the centrally published inbox config even if local storage is unavailable.
    }
    return embeddedConfig;
  }

  return loadStoredAiInboxConfig();
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

function resolveDataSourceUrl(source) {
  const url = new URL(source.url, window.location.href);
  const isLiveDashboardData = url.pathname.endsWith("/data/latest.enc.json") ||
    url.pathname.endsWith("/data/latest.json");
  if (isLiveDashboardData) {
    url.searchParams.set("cache_bust", String(Date.now()));
  }
  return url.href;
}

async function loadData() {
  for (const source of dataSources) {
    try {
      const response = await fetch(resolveDataSourceUrl(source), {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
        },
      });
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

function ensureDataLoad() {
  if (!state.dataLoadPromise) {
    state.dataLoadPromise = loadData();
  }
  return state.dataLoadPromise;
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

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function ghnStatusLabel(status) {
  const labels = {
    ready_to_pick: "Chờ lấy hàng",
    picking: "Đang lấy hàng",
    money_collect_picking: "Đang lấy hàng",
    picked: "Đã lấy hàng",
    storing: "Đang lưu kho",
    transporting: "Đang luân chuyển",
    sorting: "Đang phân loại",
    delivering: "Đang giao hàng",
    money_collect_delivering: "Đang giao / thu tiền",
    delivered: "Giao thành công",
    delivery_fail: "Giao không thành công",
    waiting_to_return: "Chờ hoàn hàng",
    return: "Đang hoàn hàng",
    return_transporting: "Đang chuyển hoàn",
    return_sorting: "Đang phân loại hoàn",
    returning: "Đang giao hoàn shop",
    return_fail: "Hoàn hàng thất bại",
    returned: "Đã hoàn hàng",
    cancel: "Đã hủy",
    exception: "Có sự cố",
    damage: "Hàng hư hỏng",
    lost: "Thất lạc",
  };
  return labels[status] || status || "Không rõ trạng thái";
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function isNumericSearchTerm(term) {
  const withoutPhoneSeparators = String(term || "").replace(/[()+.\-\s]/g, "");
  return /^\d+$/.test(withoutPhoneSeparators);
}

function orderSearchFields(order) {
  return [
    order.order_code,
    order.customer_name,
    order.customer_phone,
    order.customer_address,
    order.driver_name,
    order.driver_phone,
    order.latest_reason,
    order.current_status,
    order.recommended_action,
  ];
}

function orderMatchesSearch(order) {
  const query = normalizeSearchText(state.searchQuery).trim();
  if (!query) {
    return true;
  }

  const fields = orderSearchFields(order);
  const textHaystack = normalizeSearchText(fields.join(" "));
  const digitHaystack = fields.map(cleanDigits).join(" ");
  return query.split(/\s+/).every((term) => {
    const digits = cleanDigits(term);
    if (digits && isNumericSearchTerm(term)) {
      return textHaystack.includes(term) || digitHaystack.includes(digits);
    }
    return textHaystack.includes(term);
  });
}

function visibleOrders(data = state.data) {
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  return orders.filter((order) => orderMatchesFilter(order) && orderMatchesSearch(order));
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
    redeliver: "redeliver",
    update_info_redeliver: "update_info_and_redeliver",
    complain_driver_redeliver: "complain_driver_and_redeliver",
    schedule_note_redeliver: "schedule_redelivery",
    ignore_return: "ignore_return",
    customer_confirm_receive: "redeliver",
    shipper_did_not_call: "complain_driver_and_redeliver",
    info_correct_redeliver: "redeliver",
    wrong_address_new_address: "update_address_and_redeliver",
    wrong_phone_new_phone: "update_phone_and_redeliver",
    cod_new_amount: "update_cod_and_redeliver",
    customer_schedule_redeliver: "schedule_redelivery",
    customer_refuse: "review_customer_refusal",
    shop_no_answer: "wait_for_admin",
    phone_unreachable_blocked: "review_contact_info",
    manual_done: "audit_manual_resolution",
  };
  return actions[result] || "review";
}

function syncResultSelectStyle(resultSelect) {
  resultSelect.classList.toggle("is-placeholder", resultSelect.value === "not_called");
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
      latest_fail_at: order.latest_fail_at || "",
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
      const action = state.adminActions[order.order_code] || {};
      return action.status === "pending_ai" && actionHandlesLatestFailure(order, action)
        ? buildAiRequest(order, action)
        : null;
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

function aiQueueSignature(payload, config = loadAiInboxConfig()) {
  const requestSignature = payload.requests
    .map((request) => `${request.request_id}:${request.updated_at}:${request.status}`)
    .join("|");
  return `${config.url}|${requestSignature}`;
}

async function maybeAutoSendAiQueue() {
  const payload = buildAiQueuePayload();
  const config = loadAiInboxConfig();
  if (!payload.request_count || !config.url || !config.key) {
    return;
  }

  const signature = aiQueueSignature(payload, config);
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
  searchPanelEl.hidden = !isVisible;
  cardsEl.hidden = !isVisible;
  aiQueuePanelEl.hidden = true;
}

function renderSearchMeta() {
  const orders = Array.isArray(state.data?.orders) ? state.data.orders : [];
  const query = state.searchQuery.trim();
  clearSearchButtonEl.hidden = !query;
  if (!query) {
    searchMetaEl.textContent =
      `Đang xem mục ${filterLabel()}. Nhập 4 số cuối SĐT, mã vận đơn, tên khách hoặc shipper để tìm nhanh.`;
    return;
  }

  const count = visibleOrders().length;
  const groupCount = orders.filter((order) => orderMatchesFilter(order)).length;
  const suffix =
    state.filter === "all" ? "" : " Bấm Cần chú ý để tìm trên toàn bộ danh sách.";
  searchMetaEl.textContent = `Tìm thấy ${count}/${groupCount} đơn trong mục ${filterLabel()}.${suffix}`;
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
  state.dataLoadPromise = null;

  try {
    const loaded = await ensureDataLoad();
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

      event.preventDefault();
      pullState.distance = Math.min(distance, 140);
      if (pullState.distance > 24) {
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

function showUnlockShell(message = "") {
  unlockPanelEl.hidden = false;
  setDashboardVisible(false);
  syncTimeEl.textContent = "Nhập mật khẩu để mở dashboard";
  unlockMessageEl.textContent = message;
  passwordInputEl.focus();
}

function showDashboard(data) {
  state.data = data;
  state.serverAiActions = buildServerAiActions(state.data);
  syncAdminActionsFromServer(state.data);
  unlockPanelEl.hidden = true;
  setDashboardVisible(true);
  syncTimeEl.textContent = `Cập nhật: ${state.data.generated_at || "dữ liệu mẫu"}`;
  renderSummary(state.data);
  renderSearchMeta();
  renderAiQueuePanel();
  renderCards();
  void maybeAutoSendAiQueue();
}

function renderSummary(data) {
  const summary = data.summary || {};
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const countByFilter = (filter) => orders.filter((order) => orderMatchesFilter(order, filter)).length;
  const cards = [
    ["all", "Cần chú ý", summary.current_needs_action_count ?? orders.length],
    ["CAN_XU_LY", "Cần xử lý", countByFilter("CAN_XU_LY")],
    ["CHO_AI", "Chờ AI", countByFilter("CHO_AI")],
    ["AI_DA_XU_LY", "AI đã xử lý", countByFilter("AI_DA_XU_LY")],
    ["CHO_HOAN", "Chờ hoàn", countByFilter("CHO_HOAN")],
  ];

  summaryEl.innerHTML = cards
    .map(
      ([filter, label, value]) => `
        <button
          class="summary-card ${state.filter === filter ? "is-active" : ""}"
          type="button"
          data-filter="${filter}"
          aria-pressed="${state.filter === filter ? "true" : "false"}"
        >
          <strong>${value}</strong>
          <span>${label}</span>
        </button>
      `,
    )
    .join("");
}

function filterLabel(filter = state.filter) {
  const labels = {
    all: "Cần chú ý",
    CAN_XU_LY: "Cần xử lý",
    CHO_AI: "Chờ AI",
    AI_DA_XU_LY: "AI đã xử lý",
    CHO_HOAN: "Chờ hoàn",
  };
  return labels[filter] || labels.all;
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
  const orders = visibleOrders();

  cardsEl.innerHTML = "";
  if (!orders.length) {
    const message = state.searchQuery.trim()
      ? `Không tìm thấy đơn khớp "${state.searchQuery.trim()}".`
      : "Không có đơn trong nhóm này.";
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = message;
    cardsEl.appendChild(emptyState);
    return;
  }

  for (const order of orders) {
    const node = template.content.cloneNode(true);
    node.querySelector(".priority").textContent = order.priority || "Trung bình";
    node.querySelector(".priority").classList.add(priorityClass(order.priority));
    const statusEl = node.querySelector(".status");
    statusEl.textContent = ghnStatusLabel(order.current_status);
    statusEl.title = order.current_status || "";
    node.querySelector(".order-code").textContent = order.order_code;
    node.querySelector(".customer-name").textContent = order.customer_name || "Khách";
    node.querySelector(".customer-call").href = phoneLink(order.customer_phone);
    node.querySelector(".shipper-call").href = phoneLink(order.driver_phone);
    node.querySelector(".reason").textContent = order.latest_reason || "Chưa có lý do";
    node.querySelector(".fail-count").textContent = `${order.fail_count || 0} lần${repeatFailureAiNote(order)}`;
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
    syncResultSelectStyle(resultSelect);
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
        failCount: Number(order.fail_count || 0),
        latestFailAt: order.latest_fail_at || "",
        result: resultSelect.value,
        resultLabel,
        note,
        status: "pending_ai",
      });
      renderSummary(state.data);
      renderSearchMeta();
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
      syncResultSelectStyle(resultSelect);
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
  summaryEl.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const filterButton = event.target.closest("[data-filter]");
    if (!filterButton) {
      return;
    }

    state.filter = filterButton.dataset.filter || "all";
    renderSummary(state.data);
    renderSearchMeta();
    renderCards();
  });
}

function bindSearch() {
  searchInputEl.addEventListener("input", () => {
    const hadSearch = Boolean(state.searchQuery.trim());
    state.searchQuery = searchInputEl.value;
    if (state.searchQuery.trim() && !hadSearch) {
      state.filter = "all";
      renderSummary(state.data);
    }
    renderSearchMeta();
    renderCards();
  });

  clearSearchButtonEl.addEventListener("click", () => {
    state.searchQuery = "";
    searchInputEl.value = "";
    searchInputEl.focus();
    renderSearchMeta();
    renderCards();
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
    unlockMessageEl.textContent = state.encryptedData
      ? "Đang mở dữ liệu..."
      : "Đang tải dữ liệu mới nhất, chờ một chút...";
    try {
      const passphrase = passwordInputEl.value;
      if (!state.encryptedData) {
        const loaded = await ensureDataLoad();
        if (!loaded.encrypted) {
          state.passphrase = passphrase;
          rememberPassphrase(passphrase);
          passwordInputEl.value = "";
          unlockMessageEl.textContent = "";
          showDashboard(loaded.payload);
          return;
        }
        state.encryptedData = loaded.payload;
      }
      const data = await decryptDashboardData(state.encryptedData, passphrase);
      state.passphrase = passphrase;
      rememberPassphrase(passphrase);
      passwordInputEl.value = "";
      unlockMessageEl.textContent = "";
      showDashboard(data);
    } catch {
      state.passphrase = "";
      clearRememberedPassphrase();
      unlockMessageEl.textContent = "Mật khẩu chưa đúng hoặc file dữ liệu bị lỗi.";
    }
  });
}

async function init() {
  bindFilters();
  bindSearch();
  bindAiQueue();
  bindRefresh();
  bindUnlock();

  showUnlockShell("Đang tải dữ liệu mới nhất ở nền...");
  ensureDataLoad()
    .then(async (loaded) => {
      if (loaded.encrypted) {
        state.encryptedData = loaded.payload;
        if (state.passphrase) {
          try {
            const data = await decryptDashboardData(loaded.payload, state.passphrase);
            showDashboard(data);
            return;
          } catch {
            state.passphrase = "";
            clearRememberedPassphrase();
          }
        }
        showUnlock(loaded.payload);
        unlockMessageEl.textContent = "";
      } else {
        showDashboard(loaded.payload);
      }
    })
    .catch((error) => {
      unlockMessageEl.textContent = "Chưa tải được dữ liệu. Kiểm tra mạng rồi bấm Làm mới.";
      setRefreshStatus(error.message, true);
    });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(`./sw.js?v=${appShellVersion}`)
      .then((registration) => registration.update())
      .catch(() => {});
  }
}

init().catch((error) => {
  syncTimeEl.textContent = error.message;
});
