(function () {
  if (window.__dshAssist) return
  window.__dshAssist = 1

  function portalOrigin() {
    try {
      var l = location.hostname.split('.')
      if (l.length > 2) return location.protocol + '//' + l.slice(1).join('.')
    } catch (e) {}
    return location.origin
  }
  var P = portalOrigin()

  function mk(tag, style, text) {
    var e = document.createElement(tag)
    if (style) e.setAttribute('style', style)
    if (text !== undefined) e.textContent = text
    return e
  }
  function j(u) {
    return fetch(u, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }
  function fmtSize(n) {
    if (typeof n !== 'number') return ''
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
    return n + ' B'
  }

  var CHIP =
    'cursor:pointer;border:1px solid rgba(127,127,127,.45);background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:999px;padding:5px 10px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif'
  var PANEL =
    'position:fixed;right:10px;bottom:52px;z-index:2147483000;width:min(620px,92vw);max-height:72vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#1e1e24);color:var(--dsw-alias-label-primary,#e8e8ec);border:1px solid rgba(127,127,127,.35);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.35);padding:12px 14px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif'
  var BTN = 'cursor:pointer;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:8px;padding:3px 8px;font:12px/1.4 inherit'

  function closePanel() {
    var p = document.getElementById('__dshAssistPanel')
    if (p) p.remove()
  }
  function panel(title, render) {
    closePanel()
    var p = mk('div', PANEL)
    p.id = '__dshAssistPanel'
    var head = mk('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px')
    head.appendChild(mk('strong', '', title))
    var x = mk('button', 'cursor:pointer;border:0;background:transparent;color:inherit;font-size:14px', '✕')
    x.onclick = closePanel
    head.appendChild(x)
    p.appendChild(head)
    var body = mk('div')
    p.appendChild(body)
    document.body.appendChild(p)
    render(body)
  }
  function row(label, hint) {
    var d = mk('div', 'padding:5px 0;border-bottom:1px solid rgba(127,127,127,.14)')
    d.appendChild(mk('div', 'font-weight:600', label))
    if (hint) d.appendChild(mk('div', 'opacity:.72;font-size:12px;white-space:pre-wrap', hint))
    return d
  }

  // ── 我的文件：浏览工作区 + 下载（走平台代理，不暴露宿主路径）──
  function openFiles(path) {
    panel('我的文件（工作区）', function (b) {
      b.textContent = '加载中…'
      j(P + '/api/desktop/tree?path=' + encodeURIComponent(path || ''))
        .then(function (d) {
          b.innerHTML = ''
          var bar = mk('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px')
          var up = mk('button', BTN, '⬆ 上级')
          up.onclick = function () {
            var parts = (path || '').split('/').filter(Boolean)
            parts.pop()
            openFiles(parts.join('/'))
          }
          bar.appendChild(up)
          bar.appendChild(mk('span', 'opacity:.7;font-size:12px', '/' + (path || '')))
          b.appendChild(bar)
          var entries = (d && d.entries) || []
          entries.sort(function (a, c) {
            if ((a.type === 'dir') !== (c.type === 'dir')) return a.type === 'dir' ? -1 : 1
            return String(a.name).localeCompare(String(c.name))
          })
          if (!entries.length) b.appendChild(mk('div', 'opacity:.7', '（空目录）'))
          entries.forEach(function (e) {
            var full = (path ? path + '/' : '') + e.name
            var line = mk('div', 'display:flex;justify-content:space-between;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(127,127,127,.14)')
            var name = mk('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', (e.type === 'dir' ? '📁 ' : '📄 ') + e.name)
            name.title = full
            line.appendChild(name)
            var right = mk('span', 'display:flex;gap:8px;align-items:center;flex:0 0 auto')
            if (e.type === 'dir') {
              var open = mk('button', BTN, '打开')
              open.onclick = function () {
                openFiles(full)
              }
              right.appendChild(open)
            } else {
              right.appendChild(mk('span', 'opacity:.65;font-size:12px', fmtSize(e.size)))
              var a = mk('a', BTN + ';text-decoration:none', '下载')
              a.href = P + '/api/fs/download?path=' + encodeURIComponent(full)
              a.setAttribute('download', e.name)
              right.appendChild(a)
            }
            line.appendChild(right)
            b.appendChild(line)
          })
          var foot = mk('div', 'margin-top:10px;opacity:.65;font-size:12px')
          foot.textContent = 'AI 产出的文件都在你自己的工作区里；下载走平台代理，不需要服务器路径。'
          b.appendChild(foot)
        })
        .catch(function (err) {
          b.textContent = '读取失败：' + err.message
        })
    })
  }

  // ── 能力清单：读平台生成的 abilities JSON（与实例内 skill 同源）──
  function openCaps() {
    panel('实例能力清单', function (b) {
      b.textContent = '加载中…'
      j(P + '/api/capabilities')
        .then(function (c) {
          b.innerHTML = ''
          b.appendChild(row('权限档位', c.permissionMode + ' —— ' + (c.note || '')))
          b.appendChild(row('可读', (c.read && c.read.allowed || []).join('；') + '\n不可读：' + ((c.read && c.read.denied) || []).join('；')))
          b.appendChild(row('可写', (c.write && c.write.allowed || []).join('；') + '\n不可写：' + ((c.write && c.write.denied) || []).join('；')))
          b.appendChild(
            row(
              '网络',
              '出网：' + ((c.network && c.network.egress) || '') + '\n不可达：' + ((c.network && c.network.denied) || []).join('；') + '\n' + ((c.network && c.network.hint) || ''),
            ),
          )
          var t = c.tools || {}
          b.appendChild(row('可用工具', Object.keys(t).map(function (k) { return k + '=' + t[k] }).join('  ')))
          var sk = c.skills || {}
          b.appendChild(row('已注册技能', '共享层：' + (((sk.shared) || []).join(', ') || '（空）') + '\n个人层：' + JSON.stringify(sk.perUser || {}) + '\n' + (sk.hint || '')))
          if (c.fileDelivery) b.appendChild(row('把文件交给用户', (c.fileDelivery.hint || '') + '\n❌ ' + ((c.fileDelivery.avoid) || []).join('；')))
          b.appendChild(mk('div', 'margin-top:8px;opacity:.6;font-size:12px', '生成时间：' + (c.generatedAt || '—')))
        })
        .catch(function (err) {
          b.textContent = '读取失败：' + err.message + '（能力清单可能尚未生成）'
        })
    })
  }

  // ── 档位提示：老会话仍 workspace-write 时给一条可操作的横幅 ──
  function banner(text, key) {
    try {
      if (sessionStorage.getItem(key)) return
    } catch (e) {}
    var d = mk(
      'div',
      'position:fixed;left:50%;transform:translateX(-50%);top:10px;z-index:2147483000;max-width:min(760px,94vw);background:rgba(180,120,20,.16);border:1px solid rgba(200,140,30,.5);color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:10px;padding:9px 12px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;gap:10px;align-items:flex-start',
    )
    d.appendChild(mk('div', 'flex:1;white-space:pre-wrap', text))
    var x = mk('button', 'cursor:pointer;border:0;background:transparent;color:inherit;font-size:14px;flex:0 0 auto', '✕')
    x.onclick = function () {
      try {
        sessionStorage.setItem(key, '1')
      } catch (e) {}
      d.remove()
    }
    d.appendChild(x)
    document.body.appendChild(d)
  }

  function checkPermission() {
    j(P + '/api/dsh/session-permission')
      .then(function (r) {
        if (!r || !r.stale) return
        banner(
          '当前会话的权限档位是「' +
            r.session.preset +
            '」，而本机没有可用的沙箱后端 —— AI 将无法执行任何命令（bash 会被拒绝）。\n' +
            '修法：在 dsh 界面把权限档位切到「完全权限」（或新建一个会话，新会话默认已是完全权限）。',
          '__dshPermWarn:' + (r.session && r.session.sessionId ? r.session.sessionId : 'x'),
        )
      })
      .catch(function () {})
  }

  function mount() {
    if (!document.body) return
    if (document.getElementById('__dshAssistBar')) return
    var bar = mk('div', 'position:fixed;right:10px;bottom:10px;z-index:2147483000;display:flex;gap:6px')
    bar.id = '__dshAssistBar'
    var f = mk('button', CHIP, '📁 我的文件')
    f.onclick = function () {
      openFiles('')
    }
    var c = mk('button', CHIP, '🧭 能力')
    c.onclick = openCaps
    bar.appendChild(f)
    bar.appendChild(c)
    document.body.appendChild(bar)
  }

  var tries = 0
  var timer = setInterval(function () {
    tries++
    mount()
    if (tries > 20) clearInterval(timer)
  }, 1500)
  mount()
  checkPermission()
})()
