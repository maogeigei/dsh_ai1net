/* ─────────────────────────────────────────────────────────────────────────────
 * 状态机（单一来源，R1-②）—— 本文件是「回到页面」链路**唯一**的策略实现。
 *
 * 事件（触发面）                    判定                                    动作
 * ─────────────────────────────────────────────────────────────────────────────
 * ① 切回页面 / 首次进入             探针（平台 /api/dsh/status + 实例 GET /）   坏 → 恢复；好 → 撤提示条
 *    (visibilitychange / pageshow)   提示条「正在检查工作区连接…」
 * ② 页面自己发出的请求 401          传输层已透明重放；仍失败 →      恢复
 *    或 404 not_running                                                    
 * ③ 心跳（**页面可见**时每 25 s）    soft 模式：**连续两次**失败才动作          恢复（滞后 ≤ 50 s）
 * ④ EventSource / WebSocket 断开     soft 模式：同上                          恢复（比心跳更早）
 * ⑤ 有界保护                        窗口 10 min 内恢复 > 3 次                 停手：明确失败态 + 手动「重试」
 * ─────────────────────────────────────────────────────────────────────────────
 * 恢复动作：覆盖层「工作区正在恢复…」→ POST /api/dsh/enter → 拿到新 token 的直达地址
 *          → **原地 replace（保留 path/hash）**；拿不到 url → 原地 reload。
 * 冷却/告警：平台侧 orchestrator 负责崩溃熔断与告警；本文件只管"页面这一侧"。
 * ⚠️ 改这个文件**不需要**再动 proxy.ts（R1-① 已把脚本外置），但改完必须跑
 *    `npm run verify`（会做 node --check + 内联回退检查）。
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  if (window.__dshRecover) return;
  window.__dshRecover = 1;

  // 一层覆盖层，两种用途：
  //   pending —— 请求长时间未返回（服务端正在拉起实例）→ 显示"正在启动…"，请求结束后撤掉
  //   expired —— 401（实例被回收重建，launch token 已轮换）→ 显示后整页 reload
  // expired 是终态，不可被 pending 覆盖、也不主动撤除（随后就 reload 了）。
  var state = 'none';
  var box = null;
  var ticker = null;

  function ensureCss() {
    if (document.getElementById('__dshRecoverCss')) return;
    var st = document.createElement('style');
    st.id = '__dshRecoverCss';
    // 视觉升级：整套样式一次性注入（含 prefers-reduced-motion 回退）。
    // ⚠️ 本文件是注入脚本的模板字面量 —— 内容不得含反引号 / 美元花括号；
    //    故 CSS 里的字体名一律用单引号（'Segoe UI'），JS 字符串用双引号。
    st.textContent = [
    "@keyframes __dshr-spin{to{transform:rotate(360deg)}}",
    "@keyframes __dshr-spin-rev{to{transform:rotate(-360deg)}}",
    "@keyframes __dshr-core{0%,100%{transform:scale(.82);opacity:.6}50%{transform:scale(1.12);opacity:1}}",
    "@keyframes __dshr-halo{0%,100%{opacity:.45;transform:scale(.96)}50%{opacity:.9;transform:scale(1.04)}}",
    "@keyframes __dshr-scan{0%{transform:translateX(-115%)}100%{transform:translateX(275%)}}",
    "@keyframes __dshr-dot{0%,100%{opacity:.25}50%{opacity:1}}",
    "@keyframes __dshr-sheen{0%{background-position:190% 0}100%{background-position:-90% 0}}",
    ".__dsh-ov{",
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;",
    "background:radial-gradient(900px 460px at 50% 26%, rgba(88,166,255,.13), transparent 62%),radial-gradient(760px 420px at 50% 84%, rgba(163,113,247,.13), transparent 62%),rgba(9,11,16,.9);",
    "}",
    ".__dsh-card{",
    "position:relative;display:flex;flex-direction:column;align-items:center;gap:13px;",
    "padding:26px 34px 22px;border-radius:16px;",
    "background:linear-gradient(180deg, rgba(26,31,43,.86), rgba(17,21,30,.86));",
    "box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 0 0 1px rgba(120,150,210,.16),0 18px 48px rgba(0,0,0,.5);",
    "-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);",
    "}",
    ".__dsh-orb{position:relative;width:86px;height:86px}",
    ".__dsh-halo{",
    "position:absolute;inset:-20px;border-radius:50%;",
    "background:radial-gradient(circle, rgba(88,166,255,.30), rgba(163,113,247,.17) 46%, transparent 70%);",
    "animation:__dshr-halo 2.6s ease-in-out infinite;",
    "}",
    ".__dsh-arc{",
    "position:absolute;inset:0;border-radius:50%;",
    "background:conic-gradient(from 0deg, rgba(88,166,255,0) 0deg, rgba(88,166,255,.06) 110deg, #58a6ff 296deg, #a371f7 342deg, rgba(163,113,247,0) 360deg);",
    "-webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));",
    "mask:radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));",
    "animation:__dshr-spin 1.5s linear infinite;",
    "}",
    ".__dsh-arc2{position:absolute;inset:13px;border-radius:50%;border:1px dashed rgba(163,113,247,.42);animation:__dshr-spin-rev 7s linear infinite}",
    ".__dsh-ring{position:absolute;inset:24px;border-radius:50%;border:1px solid rgba(120,160,230,.20)}",
    ".__dsh-core{",
    "position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;",
    "background:radial-gradient(circle, #eaf3ff 0%, #66b0ff 46%, rgba(88,166,255,0) 74%);",
    "box-shadow:0 0 12px rgba(88,166,255,.85),0 0 34px rgba(163,113,247,.45);",
    "animation:__dshr-core 1.6s ease-in-out infinite;",
    "}",
    ".__dsh-dots{position:absolute;inset:0;animation:__dshr-spin 3.4s linear infinite}",
    ".__dsh-dots i{position:absolute;left:50%;top:-2px;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:#a371f7;box-shadow:0 0 8px #a371f7;animation:__dshr-dot 1.4s ease-in-out infinite}",
    ".__dsh-dots i:nth-child(2){top:auto;bottom:-2px;animation-delay:.35s;background:#58a6ff;box-shadow:0 0 8px #58a6ff}",
    ".__dsh-dots i:nth-child(3){left:-2px;top:50%;margin:-2.5px 0 0 0;animation-delay:.7s;background:#7ee0c0;box-shadow:0 0 8px #7ee0c0}",
    ".__dsh-msg{",
    "font:14.5px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#e9f1fa;letter-spacing:.2px;text-align:center;",
    "background:linear-gradient(90deg, rgba(233,241,250,.94) 0%, #ffffff 48%, rgba(233,241,250,.94) 96%);",
    "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;",
    "background-size:230% 100%;animation:__dshr-sheen 3s linear infinite;",
    "}",
    ".__dsh-label{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;color:rgba(150,175,215,.72);text-transform:uppercase}",
    ".__dsh-track{position:relative;width:208px;height:3px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden}",
    ".__dsh-track i{position:absolute;top:0;bottom:0;width:42%;border-radius:3px;background:linear-gradient(90deg, transparent, #58a6ff 45%, #a371f7 70%, transparent);animation:__dshr-scan 1.45s ease-in-out infinite}",
    "@media (prefers-reduced-motion: reduce){",
    ".__dsh-arc,.__dsh-arc2,.__dsh-dots,.__dsh-dots i,.__dsh-core,.__dsh-halo,.__dsh-track i,.__dsh-msg{animation:none!important}",
    "}"
    ].join(String.fromCharCode(10));
    (document.head || document.documentElement).appendChild(st);
  }

  // spinner 只创建一次，之后仅改文案 —— 否则每次重设 innerHTML 都会重建元素，
  // 旋转动画被打断，看起来像"卡住不动"。
  function ensureBox() {
    if (box) return;
    ensureCss();
    box = document.createElement('div');
    box.id = '__dshRecover';
    box.className = '__dsh-ov';
    // 「AI 核心」加载体：扫描弧（conic 渐变）+ 反向虚线环 + 脉冲核心 + 三颗轨道粒子。
    // 全部 createElement 构建（不用 innerHTML —— 实例页可能启用 Trusted Types）。
    var card = document.createElement('div');
    card.className = '__dsh-card';
    var orb = document.createElement('div');
    orb.className = '__dsh-orb';
    var parts = ['__dsh-halo', '__dsh-arc', '__dsh-arc2', '__dsh-ring', '__dsh-core'];
    for (var i = 0; i < parts.length; i++) {
      var el = document.createElement('div');
      el.className = parts[i];
      orb.appendChild(el);
    }
    var dots = document.createElement('div');
    dots.className = '__dsh-dots';
    for (var j = 0; j < 3; j++) dots.appendChild(document.createElement('i'));
    orb.appendChild(dots);
    var tx = document.createElement('div');
    tx.id = '__dshRecoverMsg';
    tx.className = '__dsh-msg';
    var lb = document.createElement('div');
    lb.className = '__dsh-label';
    lb.textContent = 'DSH · auto recovery';
    var tr = document.createElement('div');
    tr.className = '__dsh-track';
    tr.appendChild(document.createElement('i'));
    card.appendChild(orb);
    card.appendChild(tx);
    card.appendChild(lb);
    card.appendChild(tr);
    box.appendChild(card);
    (document.body || document.documentElement).appendChild(box);
  }

  function setMsg(msg) {
    var m = document.getElementById('__dshRecoverMsg');
    if (m) m.textContent = msg;
  }

  function showPending(base) {
    if (state === 'expired') return;
    state = 'pending';
    ensureBox();
    var t0 = Date.now();
    setMsg(base + '（已等待 0 秒）');
    if (ticker) clearInterval(ticker);
    ticker = setInterval(function () {
      if (state !== 'pending') return;
      setMsg(base + '（已等待 ' + Math.floor((Date.now() - t0) / 1000) + ' 秒）');
    }, 1000);
  }

  function hidePending() {
    if (state !== 'pending') return;
    state = 'none';
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  // ── 顶部轻提示条（不遮罩）────────────────────────────────────────────────
  // 用户明确反馈「回到页面根本没看到过提示」——所以「看得见」本身就是要交付的东西。
  // 只在"离开 ≥20 秒又回来"时出现；瞬时切换不打扰。至少显示 900ms 再撤，
  // 否则一闪而过等于没提示。
  var bar = null;
  var barAt = 0;
  var barTimer = null;

  function ensureBar() {
    if (bar) return;
    ensureCss();
    bar = document.createElement('div');
    bar.id = '__dshConnBar';
    bar.setAttribute(
      'style',
      'position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:7px 12px;' +
        'text-align:center;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
        'color:#fff;background:rgba(24,95,165,.95)'
    );
    (document.body || document.documentElement).appendChild(bar);
  }

  function showBar(msg) {
    if (state === 'pending' || state === 'expired') return;
    ensureBar();
    barAt = Date.now();
    bar.textContent = msg;
    if (barTimer) {
      clearTimeout(barTimer);
      barTimer = null;
    }
  }

  function hideBar() {
    if (!bar) return;
    var wait = Math.max(0, 900 - (Date.now() - barAt));
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(function () {
      barTimer = null;
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null;
    }, wait + 60);
  }

  function expire() {
    if (state === 'expired') return;
    hideBar();
    hidePending();
    state = 'expired';
    ensureBox();
    setMsg('正在重新连接你的工作区…');
    setTimeout(function () {
      location.reload();
    }, 900);
  }

  function isApi(u) {
    return String(u).indexOf('/api/') >= 0;
  }

  // ── 实例不可用（空闲回收 / 被关闭 / 崩溃）→ 自动唤醒并重建连接────────────
  // 为什么需要：原来只认 401。实例被回收后代理对非导航请求返回 404 not_running，
  // 脚本不认识 → 页面上的请求静默失败、SSE 静默断流 → 用户只能**手动刷新**。
  //
  // 注入脚本跑在实例子域上，而平台接口（/api/dsh/*）在门户域 → 必须跨域调用；
  // server.ts 的 CORS 白名单允许 baseDomain 及其子域 + Allow-Credentials，故带 cookie 可用。
  function portalOrigin() {
    var l = location.hostname.split('.');
    if (l.length > 2) return location.protocol + '//' + l.slice(1).join('.');
    return location.origin;
  }

  var recovering = false;
  // 保留原始 fetch：探针与探活走它，避免被下面的 watch() 当成"业务请求"而误亮覆盖层。
  var rawFetch = window.fetch;

  // ── 就地恢复───────────────────────────────────────────────────
  // 不再跳门户过渡页 wake.html：那会换域名（子域 → 门户），且它的 next 是空的，
  // 恢复后落回根地址、页面状态全丢 —— 用户明确反馈这样"不自然"。
  // 改为：本页显示覆盖层 → 调一次平台 /api/dsh/enter（会拉起实例并返回**带新 token**
  // 的直达地址）→ 原地跳回，并尽量保留当前路径与 hash。
  function withPath(u) {
    try {
      var n = new URL(u, location.href);
      if (n.hostname === location.hostname && location.pathname !== '/') n.pathname = location.pathname;
      if (location.hash) n.hash = location.hash;
      return n.href;
    } catch (e) {
      return u;
    }
  }

  // ── 有界恢复（R1-③）──────────────────────────────────────────────
  // 现场事故（2026-09-13 · guest）：实例被 OOM 反复杀 → 页面「恢复 → 起来 → 又被杀」**无限循环**
  // （每 ~35 s 一次 GET /）。恢复逻辑本身没错，错在**没有上限**。
  // 规则：窗口内恢复次数超限后**停止自动恢复**，停在明确的失败态 + 手动「重试」（不自动 reload）。
  var RECOVER_WINDOW_MS = 10 * 60 * 1000;
  var RECOVER_MAX = 3;
  var recFirstAt = 0;
  var recCount = 0;

  function overRecoverBudget() {
    var now = Date.now();
    if (now - recFirstAt > RECOVER_WINDOW_MS) {
      recFirstAt = now;
      recCount = 0;
    }
    recCount += 1;
    return recCount > RECOVER_MAX;
  }

  function addRetryButton() {
    var box = document.getElementById('__dshRecover');
    if (!box || document.getElementById('__dshRetryBtn')) return;
    var b = document.createElement('button');
    b.id = '__dshRetryBtn';
    b.type = 'button';
    b.textContent = '重试';
    b.setAttribute(
      'style',
      'margin-top:14px;padding:8px 18px;border:0;border-radius:8px;cursor:pointer;' +
        'font:14px/1 system-ui,-apple-system,sans-serif;color:#fff;' +
        'background:linear-gradient(135deg,#58a6ff,#a371f7);box-shadow:0 0 18px rgba(88,166,255,.35)'
    );
    b.addEventListener('click', function () {
      recFirstAt = 0;      // 手动重试 = 重置预算
      recCount = 0;
      recovering = false;
      b.parentNode && b.parentNode.removeChild(b);
      recover('正在重新连接…');
    });
    box.appendChild(b);
  }

  function showExhausted() {
    recovering = true;                 // 保持在"不再自动恢复"的状态
    hideBar();
    ensureBox();                       // 只建覆盖层，不启动 showPending 的秒表
    setMsg('工作区暂时不可用（已连续尝试恢复 ' + RECOVER_MAX + ' 次）。可能是实例反复重启或资源不足 —— 可点下方「重试」，或稍后再来。');
    addRetryButton();
  }

  function recover(reason) {
    if (recovering) return;
    if (overRecoverBudget()) {
      showExhausted();
      return;
    }
    recovering = true;
    hideBar();
    showPending(reason || '工作区正在恢复，请稍候…');
    var go = function (url) {
      if (url) {
        setMsg('已就绪，正在返回你的工作区…');
        setTimeout(function () {
          location.replace(withPath(url));
        }, 700);
        return;
      }
      setMsg('正在重新连接…');
      setTimeout(function () {
        location.reload();
      }, 700);
    };
    rawFetch.call(window, portalOrigin() + '/api/dsh/enter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'include',
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        go(j && (j.url || j.redirect));
      })
      .catch(function () {
        go(null);
      });
  }

  // ── 探针：页面 ↔ 实例的连通性（新增，解决"看不到提示"）────────────
  // 为什么需要：门户口 /api/dsh/status 的 running 只说明「进程在不在」，
  // 而它把 starting（正在启动）也算在跑（dsh.ts 的 alive()）。实测每次崩溃后新实例
  // 1 秒内就起来 ⇒ 用户回到页面时几乎总是 starting/running ⇒ 旧判据永远不动手。
  // 探针 GET / 走实例自己的鉴权入口：200 = 这个页面确实能用；超时 / 3xx / 异常 = 已脱节。
  // 返回 404/405（官方改了入口形态）→ 'unknown' → 退回旧判据，**绝不误报**。
  function poke() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () {
      try {
        if (ctl) ctl.abort();
      } catch (e) {}
    }, 2500);
    return rawFetch
      .call(window, '/', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        signal: ctl ? ctl.signal : undefined,
      })
      .then(function (r) {
        clearTimeout(t);
        if (r.status === 200) return 'ok';
        if (r.status === 404 || r.status === 405) return 'unknown';
        return 'bad';
      })
      .catch(function () {
        clearTimeout(t);
        return 'bad';
      });
  }

  // 主动探活。必要性：实例被回收后，页面上的存量请求不一定失败（SSE 静默断流），
  // 所以"用户回到页面"这件事本身要主动问一次。
  // withNotice：真的离开过一会儿又回来 → 先亮顶部提示条（看得见的反馈）。
  var lastProbe = 0;
  // soft = true：**静默触发面**（心跳 / 流断）用 —— 必须**连续两次**失败才动手。
  // 为什么：恢复 = 原地 location.replace，页面内未保存的输入会丢；一次网络抖动不该触发它。
  var softFails = 0;
  function probe(withNotice, soft) {
    if (recovering) return;
    if (Date.now() - lastProbe < 15000) return;
    lastProbe = Date.now();
    if (withNotice) showBar('正在检查工作区连接…');
    var go = function (reason) {
      if (soft !== true) {
        recover(reason);
        return;
      }
      softFails += 1;
      if (softFails >= 2) recover(reason);
    };
    rawFetch
      .call(window, portalOrigin() + '/api/dsh/status', { credentials: 'include' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (!j) {
          hideBar();
          return;
        }
        if (j.running === false) {
          go('工作区已休眠，正在唤醒…');
          return;
        }
        return poke().then(function (verdict) {
          if (verdict === 'ok' || verdict === 'unknown') {
            softFails = 0;
            hideBar();
            return;
          }
          go('工作区正在恢复，请稍候…');
        });
      })
      .catch(function () {
        hideBar();
      });
  }

  function hit(u, s, readBody) {
    if (s === 401 && isApi(u)) {
      expire();
      return;
    }
    // 404 not_running = 实例已被回收或关闭。原先没人管这种情况，用户只能手动刷新。
    if (s === 404 && isApi(u) && typeof readBody === 'function') {
      readBody(function (text) {
        if (String(text).indexOf('not_running') >= 0) {
          recover('工作区正在恢复，请稍候…');
        }
      });
    }
  }

  // 服务端在"实例未就绪"时会 hold 住请求（最长 20 秒）等拉起，期间浏览器端原本没有任何反馈
  // —— 用户点了重连却看不出在等什么。这里给挂起的 API 请求加计时：≥3 秒就亮出覆盖层。
  // 不会误伤流式接口：SSE / ReadableStream 在**响应头到达**时 promise 就已 resolve，计时已经清掉。
  var SLOW_MS = 3000;

  function watch(u) {
    if (!isApi(u)) return function () {};
    var shown = false;
    var t = setTimeout(function () {
      shown = true;
      showPending('实例正在启动，请稍候…');
    }, SLOW_MS);
    return function () {
      clearTimeout(t);
      if (shown) hidePending();
    };
  }

  var of = window.fetch;
  if (of) {
    window.fetch = function (i) {
      var u = typeof i === 'string' ? i : (i && i.url) || '';
      var end = watch(u);
      return of.apply(this, arguments).then(
        function (r) {
          end();
          try {
            hit(u, r.status, function (cb) {
              // clone 后再读：不能消费原响应的 body，否则调用方拿不到数据
              try {
                r.clone()
                  .text()
                  .then(cb)
                  .catch(function () {});
              } catch (e) {}
            });
          } catch (e) {}
          return r;
        },
        function (e) {
          end();
          throw e;
        }
      );
    };
  }

  var oo = XMLHttpRequest.prototype.open;
  var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = u;
    return oo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    var end = watch(x.__u);
    x.addEventListener('loadend', function () {
      end();
      try {
        hit(x.__u, x.status, function (cb) {
          try {
            cb(String(x.responseText || ''));
          } catch (e) {}
        });
      } catch (e) {}
    });
    return os.apply(this, arguments);
  };

  // 「用户回到会话页面」= 切回标签页 / 点回窗口 / 从缓存恢复页面。
  // 只有"真的离开过一会儿又回来"（≥20 秒）才亮顶部提示条 —— 瞬时切换不打扰；
  // 但无论亮不亮，探针都会跑：一旦判定页面已与实例脱节就恢复并给覆盖层。
  var LEFT_MS = 20000;
  var leftAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      var away = leftAt > 0 && Date.now() - leftAt >= LEFT_MS;
      leftAt = 0;
      probe(away);
    } else {
      leftAt = Date.now();
    }
  });
  window.addEventListener('focus', function () {
    probe(false);
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) probe(true);
  });

  // ── 补丁②（2026-09-13）：补齐「连接悄悄断掉」的两条触发面 ─────────
  // 现场故障：用户**一直盯着页面**（不切标签、不 focus），实例侧连接断了（模型流挂掉），
  // 页面显示「连接异常」，而上面那些事件一个都不会来 ⇒ 既不提示也不恢复，只能手动刷新。
  // 说明：原设计（§五 方案 B「不做周期性探活」）的前提是"用户在场却不操作没有收益"，
  // 实测证明该前提不成立 —— 于是补两条**静默**触发面；两者都走 soft 模式（连续两次失败才恢复）。
  //   ① 心跳：页面**可见**时每 25 秒静默探一次（不可见时完全不付出成本）
  //   ② 流断：包装 EventSource / WebSocket 的 error / close，立即探一次（比心跳更早发现）
  var HEARTBEAT_MS = 25000;
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    probe(false, true);
  }, HEARTBEAT_MS);

  function wrapStreams() {
    var ES = window.EventSource;
    if (typeof ES === 'function') {
      var ES2 = function (url, opts) {
        var es = new ES(url, opts);
        es.addEventListener('error', function () {
          probe(false, true);
        });
        return es;
      };
      ES2.prototype = ES.prototype;
      if (ES.CONNECTING !== undefined) {
        ES2.CONNECTING = ES.CONNECTING;
        ES2.OPEN = ES.OPEN;
        ES2.CLOSED = ES.CLOSED;
      }
      window.EventSource = ES2;
    }
    var WS = window.WebSocket;
    if (typeof WS === 'function') {
      var WS2 = function (url, protocols) {
        var ws = protocols === undefined ? new WS(url) : new WS(url, protocols);
        ws.addEventListener('close', function () {
          probe(false, true);
        });
        ws.addEventListener('error', function () {
          probe(false, true);
        });
        return ws;
      };
      WS2.prototype = WS.prototype;
      if (WS.CONNECTING !== undefined) {
        WS2.CONNECTING = WS.CONNECTING;
        WS2.OPEN = WS.OPEN;
        WS2.CLOSING = WS.CLOSING;
        WS2.CLOSED = WS.CLOSED;
      }
      window.WebSocket = WS2;
    }
  }
  wrapStreams();
})();
