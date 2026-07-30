/* Qoder Reserve WebUI — multi-account pool */
(function () {
  "use strict";

  function showBootError(msg) {
    try {
      var el = document.getElementById("boot-error");
      if (!el) {
        el = document.createElement("div");
        el.id = "boot-error";
        el.style.cssText =
          "position:fixed;left:18px;bottom:18px;z-index:99;max-width:420px;padding:12px 14px;border-radius:12px;background:#3f1d1d;color:#fecaca;border:1px solid #7f1d1d;font:13px/1.4 system-ui";
        document.body.appendChild(el);
      }
      el.classList.remove("hidden");
      el.style.display = "block";
      el.textContent = String(msg || "UI error");
    } catch (_) {}
  }

  window.addEventListener("error", function (e) {
    showBootError("JS: " + (e.message || e.error || "unknown"));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    showBootError("Promise: " + (r && r.message ? r.message : String(r)));
  });

  var state = {
    defaultMode: "cn",
    status: null,
    accounts: [],
    models: [],
    messages: [],
    busy: false,
    deviceTimer: null,
  };

  function $(id) {
    return document.getElementById(id);
  }
  function need(id) {
    var el = $(id);
    if (!el) throw new Error("Missing #" + id);
    return el;
  }
  function camel(id) {
    return id.replace(/-([a-z])/g, function (_, c) {
      return c.toUpperCase();
    });
  }

  var els = {};
  var REQUIRED = [
    "mode-select",
    "badge-cn",
    "badge-global",
    "theme-toggle",
    "sidebar-foot",
    "dashboard-cards",
    "endpoints-pre",
    "btn-refresh-status",
    "add-mode",
    "add-tier",
    "add-tier-wrap",
    "add-name",
    "add-pat",
    "btn-add-pat",
    "btn-add-device",
    "btn-add-import",
    "add-device-box",
    "add-device-progress",
    "add-device-link",
    "add-msg",
    "accounts-body",
    "btn-refresh-accounts",
    "btn-logout-all",
    "auth-misc-msg",
    "models-body",
    "models-title",
    "models-msg",
    "models-filter",
    "btn-refresh-models",
    "usage-panels",
    "usage-msg",
    "chat-model",
    "chat-stream",
    "chat-system",
    "chat-log",
    "chat-input",
    "btn-chat-send",
    "btn-chat-clear",
    "chat-msg",
    "proxy-base",
    "proxy-models",
    "proxy-chat",
    "proxy-curl",
    "proxy-msg",
    "btn-copy-base",
    "btn-probe-v1",
    "set-default-model",
    "set-api-key",
    "set-theme",
    "set-config-dir",
    "btn-save-settings",
    "settings-msg",
    "toast",
  ];

  function initEls() {
    for (var i = 0; i < REQUIRED.length; i++) {
      els[camel(REQUIRED[i])] = need(REQUIRED[i]);
    }
  }

  function toast(text, ms) {
    ms = ms || 2400;
    els.toast.textContent = text;
    els.toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.classList.add("hidden");
    }, ms);
  }

  function setMsg(el, text, type) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("error", "ok");
    if (type) el.classList.add(type);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function apiUrl(path) {
    return path.charAt(0) === "/" ? path : "/" + path;
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign(
      { Accept: "application/json" },
      opts.body ? { "Content-Type": "application/json" } : {},
      opts.headers || {}
    );
    var init = Object.assign({}, opts, {
      headers: headers,
      body:
        opts.body && typeof opts.body !== "string"
          ? JSON.stringify(opts.body)
          : opts.body,
    });
    var res = await fetch(apiUrl(path), init);
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("text/event-stream") !== -1) return res;
    var text = await res.text();
    var data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { error: text.slice(0, 400) };
      }
    }
    if (!res.ok) {
      var err = data.error || data.message || res.statusText || "request failed";
      if (err && typeof err === "object") err = err.message || JSON.stringify(err);
      throw new Error(String(err));
    }
    return data;
  }

  function renderBadges() {
    var s = state.status && state.status.poolSummary;
    if (!s) {
      els.badgeCn.textContent = "CN · 0";
      els.badgeGlobal.textContent = "Global · 0";
      els.badgeCn.className = "badge badge-off";
      els.badgeGlobal.className = "badge badge-off";
      return;
    }
    els.badgeCn.textContent = "CN · " + s.cn.active + "/" + s.cn.total;
    els.badgeCn.className = s.cn.active > 0 ? "badge badge-on" : "badge badge-off";
    var gLabel =
      "Global · " +
      s.global.active +
      "/" +
      s.global.total +
      (s.global.onlyUltimate ? " (OU " + s.global.onlyUltimate + ")" : "");
    els.badgeGlobal.textContent = gLabel;
    els.badgeGlobal.className = s.global.active > 0 ? "badge badge-on" : "badge badge-off";
  }

  function renderDashboard() {
    var s = state.status;
    if (!s) return;
    var ps = s.poolSummary || { cn: {}, global: {}, total: 0 };
    var cards = [
      ["号池总数", String(ps.total || 0)],
      ["CN 可用", (ps.cn.active || 0) + " / " + (ps.cn.total || 0)],
      ["Global 可用", (ps.global.active || 0) + " / " + (ps.global.total || 0)],
      ["Global Pro", String(ps.global.pro || 0)],
      ["Only Ultimate", String(ps.global.onlyUltimate || 0)],
      ["默认回退", String(s.defaultMode || "cn").toUpperCase()],
      ["默认模型", (s.settings && s.settings.defaultModel) || "cn/auto"],
      ["配置目录", s.configDir || "—"],
    ];
    els.dashboardCards.innerHTML = cards
      .map(function (p) {
        return (
          '<div class="stat"><div class="label">' +
          escapeHtml(p[0]) +
          '</div><div class="value">' +
          escapeHtml(p[1]) +
          "</div></div>"
        );
      })
      .join("");
    els.endpointsPre.textContent = JSON.stringify(s.endpoints || {}, null, 2);
    els.sidebarFoot.textContent = s.configDir || "";
  }

  function tierLabel(a) {
    if (a.mode !== "global") return "—";
    return a.globalTier === "only_ultimate" ? "Only Ultimate" : "Pro";
  }

  function renderAccounts() {
    var list = state.accounts || [];
    if (!list.length) {
      els.accountsBody.innerHTML =
        '<tr><td colspan="7" class="muted">号池为空 — 上方添加 PAT 或浏览器登录</td></tr>';
      return;
    }
    els.accountsBody.innerHTML = list
      .map(function (a) {
        var tierCtrl =
          a.mode === "global"
            ? '<select data-tier="' +
              escapeHtml(a.id) +
              '">' +
              '<option value="pro"' +
              (a.globalTier !== "only_ultimate" ? " selected" : "") +
              ">Pro</option>" +
              '<option value="only_ultimate"' +
              (a.globalTier === "only_ultimate" ? " selected" : "") +
              ">Only Ultimate</option></select>"
            : "—";
        var statusBadge =
          '<span class="badge ' +
          (a.status === "active"
            ? "badge-on"
            : a.status === "rate_limited"
              ? "badge-warn"
              : "badge-off") +
          '">' +
          escapeHtml(a.status) +
          "</span>";
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(a.name) +
          '<div class="muted sm"><code>' +
          escapeHtml(a.id.slice(0, 8)) +
          "…</code></div></td>" +
          "<td>" +
          escapeHtml(a.mode) +
          "</td>" +
          "<td>" +
          tierCtrl +
          "</td>" +
          "<td>" +
          statusBadge +
          "</td>" +
          "<td>" +
          escapeHtml(a.profileName || a.email || a.userID || "—") +
          "</td>" +
          "<td class=\"sm\">" +
          escapeHtml(a.expiresAt || "") +
          (a.expired ? " ⚠" : "") +
          "</td>" +
          "<td class=\"row gap wrap\">" +
          (a.status !== "active"
            ? '<button type="button" class="btn ghost sm" data-enable="' +
              escapeHtml(a.id) +
              '">启用</button>'
            : '<button type="button" class="btn ghost sm" data-disable="' +
              escapeHtml(a.id) +
              '">禁用</button>') +
          '<button type="button" class="btn danger ghost sm" data-rm="' +
          escapeHtml(a.id) +
          '">删除</button></td></tr>'
        );
      })
      .join("");
  }

  async function refreshStatus() {
    state.status = await api("/api/status");
    state.accounts = state.status.accounts || [];
    state.defaultMode = state.status.defaultMode || state.status.mode || "cn";
    els.modeSelect.value = state.defaultMode;
    if (state.status.settings && state.status.settings.theme) {
      applyTheme(state.status.settings.theme);
    }
    if (state.status.settings && state.status.settings.defaultModel) {
      els.setDefaultModel.value = state.status.settings.defaultModel;
    }
    els.setConfigDir.textContent = state.status.configDir || "—";
    syncAddTierVisibility();
    renderBadges();
    renderDashboard();
    renderAccounts();
    updateProxyInfo();
  }

  function syncAddTierVisibility() {
    els.addTierWrap.style.display = els.addMode.value === "global" ? "" : "none";
  }

  async function refreshAccounts() {
    var data = await api("/api/accounts");
    state.accounts = data.accounts || [];
    if (state.status) state.status.poolSummary = data.summary;
    renderAccounts();
    renderBadges();
    renderDashboard();
  }

  async function refreshModels() {
    setMsg(els.modelsMsg, "加载中…");
    try {
      var data = await api("/api/models?mode=all");
      state.models = data.models || [];
      renderModelsTable();
      fillModelSelect();
      setMsg(els.modelsMsg, "共 " + state.models.length + " 个模型", "ok");
    } catch (e) {
      els.modelsBody.innerHTML =
        '<tr><td colspan="7" class="muted">' + escapeHtml(e.message) + "</td></tr>";
      setMsg(els.modelsMsg, e.message, "error");
    }
  }

  function filteredModels() {
    var f = els.modelsFilter.value || "all";
    if (f === "all") return state.models;
    return state.models.filter(function (m) {
      return m.mode === f;
    });
  }

  function renderModelsTable() {
    var list = filteredModels();
    els.modelsTitle.textContent = "模型列表 · " + list.length;
    if (!list.length) {
      els.modelsBody.innerHTML = '<tr><td colspan="7" class="muted">无模型</td></tr>';
      return;
    }
    els.modelsBody.innerHTML = list
      .map(function (m) {
        return (
          "<tr><td><span class=\"badge " +
          (m.mode === "cn" ? "badge-on" : "badge-warn") +
          '">' +
          escapeHtml(m.mode) +
          "</span></td><td><code>" +
          escapeHtml(m.id) +
          "</code></td><td><code>" +
          escapeHtml(m.key) +
          "</code></td><td>" +
          (m.contextWindow != null ? m.contextWindow : "—") +
          "</td><td>" +
          (m.reasoning ? "Y" : "N") +
          "</td><td>" +
          escapeHtml(m.name || "") +
          '</td><td><button type="button" class="btn ghost sm" data-pick-model="' +
          escapeHtml(m.id) +
          '">选用</button></td></tr>'
        );
      })
      .join("");
  }

  function fillModelSelect() {
    var preferred =
      els.setDefaultModel.value ||
      (state.status && state.status.settings && state.status.settings.defaultModel) ||
      "cn/auto";
    var groups = { cn: [], global: [] };
    state.models.forEach(function (m) {
      if (groups[m.mode]) groups[m.mode].push(m);
    });
    var html = "";
    ["cn", "global"].forEach(function (mode) {
      var arr = groups[mode] || [];
      if (!arr.length) return;
      html += '<optgroup label="' + mode.toUpperCase() + '">';
      arr.forEach(function (m) {
        html +=
          '<option value="' +
          escapeHtml(m.id) +
          '">' +
          escapeHtml(m.id) +
          " — " +
          escapeHtml(m.name || "") +
          "</option>";
      });
      html += "</optgroup>";
    });
    if (!html) {
      html =
        '<option value="cn/auto">cn/auto</option><option value="global/ultimate">global/ultimate</option><option value="global/auto">global/auto</option>';
    }
    els.chatModel.innerHTML = html;
    var ids = state.models.map(function (m) {
      return m.id;
    });
    els.chatModel.value = ids.indexOf(preferred) >= 0 ? preferred : ids[0] || preferred;
  }

  async function refreshUsage() {
    setMsg(els.usageMsg, "加载中…");
    try {
      var data = await api("/api/usage?mode=all");
      els.usagePanels.innerHTML = ["cn", "global"]
        .map(function (mode) {
          var block = data[mode];
          if (!block) {
            return (
              '<div class="card"><h3>' + mode.toUpperCase() + '</h3><p class="muted">无数据</p></div>'
            );
          }
          if (block.error) {
            return (
              '<div class="card"><h3>' +
              mode.toUpperCase() +
              '</h3><p class="msg error">' +
              escapeHtml(block.error) +
              "</p></div>"
            );
          }
          var buckets = (block.buckets || [])
            .map(function (b) {
              return (
                '<div class="stat"><div class="label">' +
                escapeHtml(b.label || b.id) +
                '</div><div class="value" style="font-size:15px">' +
                escapeHtml(
                  String(b.used != null ? b.used : "—") +
                    " / " +
                    String(b.total != null ? b.total : "—") +
                    " " +
                    (b.unit || "")
                ) +
                "</div></div>"
              );
            })
            .join("");
          return (
            '<div class="card"><h3>' +
            mode.toUpperCase() +
            '</h3><p class="muted">' +
            escapeHtml(block.summary || "") +
            '</p><div class="grid cards mt">' +
            (buckets || '<div class="muted">无配额</div>') +
            "</div></div>"
          );
        })
        .join("");
      setMsg(els.usageMsg, "", "ok");
    } catch (e) {
      setMsg(els.usageMsg, e.message, "error");
    }
  }

  function updateProxyInfo() {
    var origin = location.origin;
    var base = origin + "/v1";
    els.proxyBase.textContent = base;
    els.proxyModels.textContent = base + "/models";
    els.proxyChat.textContent = base + "/chat/completions";
    els.proxyCurl.textContent =
      "# Pro models use Pro Global accounts; ultimate can use Only Ultimate too\n" +
      "curl " +
      base +
      '/chat/completions -H "Content-Type: application/json" \\\n' +
      '  -d "{\\"model\\":\\"global/ultimate\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"\n\n' +
      "curl " +
      base +
      '/chat/completions -H "Content-Type: application/json" \\\n' +
      '  -d "{\\"model\\":\\"cn/auto\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"';
  }

  function applyTheme(theme) {
    document.body.classList.toggle("light", theme === "light");
    document.body.classList.toggle("dark", theme !== "light");
    els.setTheme.value = theme === "light" ? "light" : "dark";
    try {
      localStorage.setItem("qr-theme", theme);
    } catch (_) {}
  }

  function switchTab(name) {
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.id === name);
    });
    try {
      location.hash = name;
    } catch (_) {}
    if (name === "models") refreshModels();
    if (name === "usage") refreshUsage();
    if (name === "proxy") updateProxyInfo();
    if (name === "auth") refreshAccounts().catch(function () {});
  }

  function renderChat() {
    els.chatLog.innerHTML = state.messages
      .map(function (m) {
        var reasoning = m.reasoning
          ? '<div class="reasoning">' + escapeHtml(m.reasoning) + "</div>"
          : "";
        var tools =
          m.tool_calls && m.tool_calls.length
            ? '<pre class="tools">' +
              escapeHtml(JSON.stringify(m.tool_calls, null, 2)) +
              "</pre>"
            : "";
        return (
          '<div class="bubble ' +
          escapeHtml(m.role) +
          '"><div class="role">' +
          escapeHtml(m.role) +
          "</div><div>" +
          escapeHtml(m.content || "") +
          "</div>" +
          reasoning +
          tools +
          "</div>"
        );
      })
      .join("");
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  async function sendChat() {
    if (state.busy) return;
    var text = els.chatInput.value.trim();
    if (!text) return;
    var model = els.chatModel.value || "cn/auto";
    var system = els.chatSystem.value.trim();
    var stream = els.chatStream.checked;

    state.messages.push({ role: "user", content: text });
    els.chatInput.value = "";
    renderChat();

    var payloadMessages = [];
    if (system) payloadMessages.push({ role: "system", content: system });
    state.messages.forEach(function (m) {
      if (m.role === "user" || m.role === "assistant") {
        payloadMessages.push({ role: m.role, content: m.content || "" });
      }
    });

    state.busy = true;
    els.btnChatSend.disabled = true;
    setMsg(els.chatMsg, "请求中… (" + model + " · 号池调度)");

    var assistant = { role: "assistant", content: "", reasoning: "", tool_calls: [] };
    state.messages.push(assistant);
    renderChat();

    try {
      if (!stream) {
        var result = await api("/api/chat", {
          method: "POST",
          body: { model: model, stream: false, messages: payloadMessages },
        });
        assistant.content = result.content || "";
        assistant.reasoning = result.reasoning || "";
        assistant.tool_calls = result.tool_calls || [];
        renderChat();
        setMsg(els.chatMsg, "完成 · " + model, "ok");
      } else {
        var res = await fetch(apiUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            model: model,
            stream: true,
            messages: payloadMessages,
          }),
        });
        if (!res.ok) throw new Error((await res.text()) || res.statusText);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";
        var eventName = "message";
        var toolMap = new Map();
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          var parts = buf.split("\n");
          buf = parts.pop() || "";
          for (var i = 0; i < parts.length; i++) {
            var line = parts[i];
            if (line.indexOf("event:") === 0) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (line.indexOf("data:") !== 0) continue;
            var dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            var data;
            try {
              data = JSON.parse(dataStr);
            } catch (_) {
              continue;
            }
            var type = data.type || eventName;
            if (type === "text") assistant.content += data.text || "";
            else if (type === "reasoning") assistant.reasoning += data.text || "";
            else if (type === "tool_call_delta") {
              var idx = data.index != null ? data.index : 0;
              var tc = toolMap.get(idx);
              if (!tc) {
                tc = {
                  id: data.id || "call_" + idx,
                  type: "function",
                  function: { name: data.name || "", arguments: "" },
                };
                toolMap.set(idx, tc);
              }
              if (data.id) tc.id = data.id;
              if (data.name) tc.function.name = data.name;
              if (data.arguments) tc.function.arguments += data.arguments;
              assistant.tool_calls = Array.from(toolMap.values());
            } else if (type === "tool_call") {
              toolMap.set(data.index != null ? data.index : toolMap.size, {
                id: data.id,
                type: "function",
                function: { name: data.name, arguments: data.arguments },
              });
              assistant.tool_calls = Array.from(toolMap.values());
            } else if (type === "error") throw new Error(data.error || "chat error");
            renderChat();
          }
        }
        setMsg(els.chatMsg, "完成 · " + model, "ok");
      }
    } catch (e) {
      assistant.content = assistant.content || "(错误) " + e.message;
      renderChat();
      setMsg(els.chatMsg, e.message, "error");
      if (/no active account|not logged in|no available/i.test(e.message)) {
        toast("号池无可用账号 — 请到「账号号池」添加");
      }
    } finally {
      state.busy = false;
      els.btnChatSend.disabled = false;
    }
  }

  async function addWithPat() {
    var mode = els.addMode.value;
    var pat = els.addPat.value.trim();
    if (!pat) {
      setMsg(els.addMsg, "请输入 PAT", "error");
      return;
    }
    setMsg(els.addMsg, "加入号池中…");
    try {
      var body = {
        mode: mode,
        pat: pat,
        name: els.addName.value.trim() || undefined,
      };
      if (mode === "global") body.globalTier = els.addTier.value;
      await api("/api/accounts", { method: "POST", body: body });
      els.addPat.value = "";
      setMsg(els.addMsg, "已加入号池", "ok");
      toast("账号已添加");
      await refreshStatus();
    } catch (e) {
      setMsg(els.addMsg, e.message, "error");
    }
  }

  async function addDevice() {
    clearInterval(state.deviceTimer);
    var mode = els.addMode.value;
    setMsg(els.addMsg, "启动浏览器登录…");
    els.addDeviceBox.classList.add("hidden");
    try {
      var body = {
        mode: mode,
        device: true,
        name: els.addName.value.trim() || undefined,
      };
      if (mode === "global") body.globalTier = els.addTier.value;
      var data = await api("/api/accounts", { method: "POST", body: body });
      if (data.method === "pat") {
        setMsg(els.addMsg, "已添加", "ok");
        await refreshStatus();
        return;
      }
      var sessionId = data.sessionId;
      els.addDeviceBox.classList.remove("hidden");
      setMsg(els.addMsg, "等待授权…");
      state.deviceTimer = setInterval(async function () {
        try {
          var st = await api("/api/auth/device/" + encodeURIComponent(sessionId));
          if (st.loginUrl) {
            els.addDeviceLink.href = st.loginUrl;
            els.addDeviceLink.textContent = st.loginUrl;
          }
          els.addDeviceProgress.textContent = st.progress || st.status || "";
          if (st.status === "ok") {
            clearInterval(state.deviceTimer);
            setMsg(els.addMsg, "已加入号池", "ok");
            toast("浏览器登录成功");
            await refreshStatus();
          } else if (st.status === "error") {
            clearInterval(state.deviceTimer);
            setMsg(els.addMsg, st.error || "失败", "error");
          }
        } catch (e) {
          clearInterval(state.deviceTimer);
          setMsg(els.addMsg, e.message, "error");
        }
      }, 2000);
    } catch (e) {
      setMsg(els.addMsg, e.message, "error");
    }
  }

  function bindEvents() {
    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchTab(btn.getAttribute("data-tab"));
      });
    });
    els.modeSelect.addEventListener("change", async function () {
      await api("/api/mode", { method: "POST", body: { mode: els.modeSelect.value } });
      toast("默认回退 → " + els.modeSelect.value.toUpperCase());
      await refreshStatus();
    });
    els.addMode.addEventListener("change", syncAddTierVisibility);
    els.btnAddPat.addEventListener("click", addWithPat);
    els.btnAddDevice.addEventListener("click", addDevice);
    els.btnAddImport.addEventListener("click", async function () {
      setMsg(els.addMsg, "导入中…");
      try {
        var body = {
          mode: els.addMode.value,
          name: els.addName.value.trim() || undefined,
        };
        if (els.addMode.value === "global") body.globalTier = els.addTier.value;
        await api("/api/accounts/import", { method: "POST", body: body });
        setMsg(els.addMsg, "导入成功", "ok");
        await refreshStatus();
      } catch (e) {
        setMsg(els.addMsg, e.message, "error");
      }
    });
    els.btnRefreshAccounts.addEventListener("click", function () {
      refreshAccounts().catch(function (e) {
        toast(e.message);
      });
    });
    els.btnLogoutAll.addEventListener("click", async function () {
      if (!confirm("确定清空整个号池？")) return;
      await api("/api/auth/logout", { method: "POST", body: { all: true } });
      setMsg(els.authMiscMsg, "号池已清空", "ok");
      await refreshStatus();
    });
    els.accountsBody.addEventListener("change", async function (e) {
      var sel = e.target.closest("select[data-tier]");
      if (!sel) return;
      var id = sel.getAttribute("data-tier");
      try {
        await api("/api/accounts/" + encodeURIComponent(id), {
          method: "PATCH",
          body: { globalTier: sel.value },
        });
        toast("已更新类型: " + sel.value);
        await refreshStatus();
      } catch (err) {
        toast(err.message);
      }
    });
    els.accountsBody.addEventListener("click", async function (e) {
      var rm = e.target.closest("[data-rm]");
      if (rm) {
        if (!confirm("删除该账号？")) return;
        await api("/api/accounts/" + encodeURIComponent(rm.getAttribute("data-rm")), {
          method: "DELETE",
        });
        await refreshStatus();
        return;
      }
      var en = e.target.closest("[data-enable]");
      if (en) {
        await api("/api/accounts/" + encodeURIComponent(en.getAttribute("data-enable")), {
          method: "PATCH",
          body: { status: "active" },
        });
        await refreshStatus();
        return;
      }
      var dis = e.target.closest("[data-disable]");
      if (dis) {
        await api("/api/accounts/" + encodeURIComponent(dis.getAttribute("data-disable")), {
          method: "PATCH",
          body: { status: "disabled" },
        });
        await refreshStatus();
      }
    });

    els.btnRefreshStatus.addEventListener("click", function () {
      refreshStatus().catch(function (e) {
        toast(e.message);
      });
    });
    els.btnRefreshModels.addEventListener("click", function () {
      refreshModels();
    });
    els.modelsFilter.addEventListener("change", renderModelsTable);
    els.modelsBody.addEventListener("click", function (e) {
      var t = e.target.closest("[data-pick-model]");
      if (!t) return;
      var id = t.getAttribute("data-pick-model");
      els.chatModel.value = id;
      els.setDefaultModel.value = id;
      toast("已选用 " + id);
      switchTab("chat");
    });
    els.btnChatSend.addEventListener("click", sendChat);
    els.btnChatClear.addEventListener("click", function () {
      state.messages = [];
      renderChat();
      setMsg(els.chatMsg, "");
    });
    els.chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendChat();
      }
    });
    els.btnCopyBase.addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText(els.proxyBase.textContent);
        toast("已复制");
      } catch (_) {
        toast("复制失败");
      }
    });
    els.btnProbeV1.addEventListener("click", async function () {
      setMsg(els.proxyMsg, "探活中…");
      try {
        var headers = {};
        if (els.setApiKey.value.trim())
          headers.Authorization = "Bearer " + els.setApiKey.value.trim();
        var res = await fetch(apiUrl("/v1/models"), { headers: headers });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
        var list = data.data || [];
        setMsg(els.proxyMsg, "OK · " + list.length + " models", "ok");
      } catch (e) {
        setMsg(els.proxyMsg, e.message, "error");
      }
    });
    els.btnSaveSettings.addEventListener("click", async function () {
      try {
        var body = {
          defaultModel: els.setDefaultModel.value.trim() || "cn/auto",
          theme: els.setTheme.value,
        };
        if (els.setApiKey.value.trim()) body.proxyApiKey = els.setApiKey.value.trim();
        await api("/api/settings", { method: "PUT", body: body });
        applyTheme(body.theme);
        els.setApiKey.value = "";
        setMsg(els.settingsMsg, "已保存", "ok");
        await refreshStatus();
        fillModelSelect();
        toast("设置已保存");
      } catch (e) {
        setMsg(els.settingsMsg, e.message, "error");
      }
    });
    els.themeToggle.addEventListener("click", function () {
      var next = document.body.classList.contains("light") ? "dark" : "light";
      applyTheme(next);
      api("/api/settings", { method: "PUT", body: { theme: next } }).catch(function () {});
    });
    els.setTheme.addEventListener("change", function () {
      applyTheme(els.setTheme.value);
    });
  }

  async function boot() {
    initEls();
    bindEvents();
    syncAddTierVisibility();
    try {
      var savedTheme = localStorage.getItem("qr-theme");
      if (savedTheme) applyTheme(savedTheme);
    } catch (_) {}
    var hash = (location.hash || "").replace(/^#/, "");
    if (hash) switchTab(hash);
    try {
      await refreshStatus();
      await Promise.allSettled([refreshModels(), refreshUsage()]);
      toast("号池 WebUI 就绪");
    } catch (e) {
      showBootError("无法连接后端: " + e.message);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      boot().catch(function (e) {
        showBootError(e.message || String(e));
      });
    });
  } else {
    boot().catch(function (e) {
      showBootError(e.message || String(e));
    });
  }
})();
