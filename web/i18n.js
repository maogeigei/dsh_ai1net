/*!
 * 平台多语言运行时（R5 §10.2 / §10.9）
 *
 * ⚠️ 口径（用户 2026-09-15 定）：**这个项目是全球化的 ⇒ 默认语言 = 英语**。
 *    语言选择优先级：`?lang=` → cookie `dsh_lang` → `navigator.language`（**仅命中支持列表才用**）→ **`en`**。
 *    ⚠️ cookie 名**不得含平台内部名**（`scripts/verify-static.mjs` 的 `BANNED` 去痕迹约束会拦）⇒ 用 `dsh_lang`。
 *    （保留 navigator 一步是全球化产品的常规做法；若要「忽略浏览器、一律英文」，删掉 resolve() 里那一档即可。）
 *
 * 用法（静态页）：
 *   1) <script src="/i18n.js"></script>          ← 放 <head>，阻塞加载（体积小，避免闪文案）
 *   2) 文案打标：<h1 data-i18n="login.title">登录</h1>
 *                  <input data-i18n-attr="placeholder:login.username" />
 *                  （多属性用逗号分隔：attr:key,attr2:key2）
 *   3) 语言切换控件：页面上放一个容器 <div data-i18n-switch></div> ⇒ 运行时自动渲染下拉
 *   4) 脚本里的动态文案：I18N.t('login.busy')
 *
 * 纪律（防回归）：用户可见文案**必须**走词条；缺 key 时回退英文并 warn —— **不出现空文案、不出现裸 key**。
 * ⛔ 本文件只做「渲染期替换」，不碰业务逻辑；不引任何外部依赖。
 */
;(function () {
  'use strict'

  // ⚠️ 语言 id 与**官方 dsh 保持一致**（`en` / `zh`，见官方 `dsh-client-locale` 的 `LOCALE_IDS`），
  //    便于日后把平台语言透传给实例（`settings.yaml` 的 `locale.preference`）而无需再映射。
  var SUPPORTED = ['en', 'zh']
  var DEFAULT = 'en'
  var COOKIE = 'dsh_lang'

  // ── 词条表（扁平 key）────────────────────────────────────────────
  var DICT = {
    en: {
      'common.language': 'Language',
      'common.busy': 'Working…',
      'common.show': 'Show',
      'common.hide': 'Hide',
      'common.showPw': 'Show password',
      'common.hidePw': 'Hide password',
      'common.retry': 'Retry',

      // 品牌名（2026-09-19）：登录 / 注册页的品牌标识由 DeepSeek 图形改为**本平台文字标识**。
      // ⚠️ 走词条而不是写死在 HTML 里：英文/其他语言 = CapabilityNet（en 也是**其他语言的回退**，
      //    `lookup()` 缺 key 时正是回退到 en），中文 = 能力网络（2026-09-19 定名）。
      'brand.name': 'CapabilityNet',

      'index.title': 'Workspace',

      'login.title': 'Sign in',
      'login.sub': 'Welcome to the AI world',
      'login.username': 'Username',
      'login.password': 'Password',
      'login.submit': 'Sign in',
      'login.noAccount': "Don't have an account?",
      'login.register': 'Sign up',
      'login.signingIn': 'Signing in…',
      'login.entering': 'Entering the workspace…',
      'login.errPending': 'Your account is awaiting admin review',
      'login.errDisabled': 'Your account has been disabled',
      'login.errBadCreds': 'Incorrect username or password',
      'login.errStarting': 'The instance is starting, please retry shortly',
      'login.errEnter': 'Failed to enter the workspace: ',
      'login.errNetwork': 'Failed to enter the workspace: network error',
      'login.gotoAdmin': 'go to the admin portal',

      'register.title': 'Sign up',
      'register.sub': 'Your account must be approved by an admin before you can sign in',
      'register.username': 'Username (3–32 letters / digits / underscore / hyphen)',
      'register.password': 'Password (at least 8 characters)',
      'register.submit': 'Sign up',
      'register.hasAccount': 'Already have an account?',
      'register.signIn': 'Sign in',
      'register.signingUp': 'Signing up…',
      'register.errTaken': 'That username is already taken',
      'register.errFailed': 'Sign-up failed',
      'register.ok': 'Signed up. Please wait for admin approval before signing in.',
      // 邮箱验证码 + 人机验证
      'register.email': 'E-mail',
      'register.emailPh': 'you@example.com',
      'register.code': 'E-mail verification code',
      'register.codePh': '6-digit code',
      'register.sendCode': 'Send code',
      'register.sendingCode': 'Sending…',
      'register.resendIn': 'Resend in {n}s',
      'register.codeSent': 'Code sent — check your inbox (and the spam folder).',
      'register.captcha': 'Human verification',
      'register.captchaLoading': 'Loading…',
      'register.errEmail': 'Enter a valid e-mail address',
      'register.errEmailTaken': 'That e-mail is already registered',
      'register.errEmailRequired': 'E-mail and verification code are required',
      'register.errCode': 'Invalid or expired code',
      'register.errCodeExhausted': 'Too many attempts — please request a new code',
      'register.errCooldown': 'Too many requests — please wait {n}s',
      'register.errMail': 'Could not send the e-mail — please try again later',
      'register.errCaptcha': 'Human verification failed — please retry',
      'register.errCaptchaLoad': 'Human verification could not load. Disable ad-blockers or switch network, then reload.',
      'register.errCaptchaToken': 'Finish the human verification first',
      'register.errUnavailable': 'E-mail verification is unavailable right now',
      'register.errUsername': 'Username must be 3–32 letters / digits / _ / -',
      'register.errPassword': 'Password must be at least 8 characters',
      'register.errBusy': 'Please wait a moment and try again',

      'wake.title': 'Starting your workspace',
      'wake.h1': 'Starting your workspace…',
      'wake.sub': 'Idle instances get reclaimed; the first visit takes a few seconds to spin it back up.',
      'wake.connecting': 'Connecting…',
      'wake.launching': 'Launching the instance (attempt 1, usually 5–15 seconds)…',
      'wake.retrying': 'Retrying (attempt {n})…',
      'wake.ready': 'Ready — redirecting…',
      'wake.circuit': 'The instance kept crashing, so automatic launching is paused (you can retry in about {min} min). If this keeps happening, ask an admin to check the maintenance log.',
      'wake.notReady': 'Not ready yet — retrying in 2 seconds…',
      'wake.giveUp': 'Still not ready after several attempts: {msg}',
      'wake.unknownErr': 'unknown error',
      'wake.failed': 'Startup failed',
      'wake.noteShort': 'This page redirects automatically; no need to refresh manually.',
      'wake.note': 'If nothing happens for a while, click “Retry”. This page redirects automatically — no manual refresh needed.',
    },
    zh: {
      'common.language': '语言',
      'common.busy': '处理中…',
      'common.show': '显示',
      'common.hide': '隐藏',
      'common.showPw': '显示密码',
      'common.hidePw': '隐藏密码',
      'common.retry': '重试',

      // 品牌名（2026-09-19）：中文界面显示中文名；其余语言由 en 词条（CapabilityNet）兜底。
      // ⚠️ 中文名 2026-09-19 定为「能力网络」（用户口径；此前短暂用过「能力枢纽」/「能力领域」）。
      'brand.name': '能力网络',

      'index.title': '工作台',

      'login.title': '登录',
      'login.sub': '欢迎进入AI世界',
      'login.username': '用户名',
      'login.password': '密码',
      'login.submit': '登 录',
      'login.noAccount': '还没有账号？',
      'login.register': '注册',
      'login.signingIn': '登录中…',
      'login.entering': '正在进入工作台…',
      'login.errPending': '账号待管理员审核',
      'login.errDisabled': '账号已被禁用',
      'login.errBadCreds': '用户名或密码错误',
      'login.errStarting': '实例正在启动，请稍后重试',
      'login.errEnter': '进入工作台失败：',
      'login.errNetwork': '进入工作台失败：网络错误',
      'login.gotoAdmin': '前往管理台',

      'register.title': '注册',
      'register.sub': '注册后需管理员审核方可登录',
      'register.username': '用户名（3–32 位字母/数字/下划线/连字符）',
      'register.password': '密码（至少 8 位）',
      'register.submit': '注 册',
      'register.hasAccount': '已有账号？',
      'register.signIn': '登录',
      'register.signingUp': '注册中…',
      'register.errTaken': '用户名已被占用',
      'register.errFailed': '注册失败',
      'register.ok': '注册成功，请等待管理员审核后登录。',
      // 邮箱验证码 + 人机验证
      'register.email': '邮箱',
      'register.emailPh': 'you@example.com',
      'register.code': '邮箱验证码',
      'register.codePh': '6 位数字验证码',
      'register.sendCode': '获取验证码',
      'register.sendingCode': '发送中…',
      'register.resendIn': '{n} 秒后可重发',
      'register.codeSent': '验证码已发送，请查收邮件（含垃圾箱）。',
      'register.captcha': '人机验证',
      'register.captchaLoading': '加载中…',
      'register.errEmail': '请输入有效的邮箱地址',
      'register.errEmailTaken': '该邮箱已被注册',
      'register.errEmailRequired': '请填写邮箱与验证码',
      'register.errCode': '验证码错误或已过期',
      'register.errCodeExhausted': '尝试次数过多，请重新获取验证码',
      'register.errCooldown': '请求过于频繁，请等 {n} 秒后再试',
      'register.errMail': '邮件发送失败，请稍后再试',
      'register.errCaptcha': '人机验证未通过，请重试',
      'register.errCaptchaLoad': '人机验证加载失败：请关闭广告拦截插件或更换网络后刷新页面。',
      'register.errCaptchaToken': '请先完成人机验证',
      'register.errUnavailable': '邮箱验证当前不可用',
      'register.errUsername': '用户名需为 3–32 位字母 / 数字 / _ / -',
      'register.errPassword': '密码至少 8 位',
      'register.errBusy': '请稍候再试',

      'wake.title': '正在启动工作区',
      'wake.h1': '正在启动你的工作区…',
      'wake.sub': '空闲一段时间后实例会被回收，首次访问需要几秒重新拉起。',
      'wake.connecting': '正在连接…',
      'wake.launching': '正在拉起实例（第 1 次，通常 5–15 秒）…',
      'wake.retrying': '正在重试（第 {n} 次）…',
      'wake.ready': '已就绪，正在跳转…',
      'wake.circuit': '实例连续崩溃，平台已暂停自动拉起（约 {min} 分钟后可重试）。若反复出现，请联系管理员查看维护日志。',
      'wake.notReady': '未就绪，2 秒后自动重试…',
      'wake.giveUp': '多次尝试仍未就绪：{msg}',
      'wake.unknownErr': '未知错误',
      'wake.failed': '启动失败',
      'wake.noteShort': '本页会自动跳转，无需手动刷新。',
      'wake.note': '若长时间无反应，可点「重试」。本页会自动跳转，无需手动刷新。',
    },
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  function writeCookie(name, value) {
    document.cookie =
      name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax'
  }

  /** 把浏览器语言（如 `zh-CN` / `zh` / `en-US` / `ja`）映射到受支持语言；映射不到返回 null。 */
  function matchSupported(tag) {
    if (!tag) return null
    var lower = String(tag).toLowerCase()
    for (var i = 0; i < SUPPORTED.length; i++) {
      if (SUPPORTED[i].toLowerCase() === lower) return SUPPORTED[i]
    }
    var base = lower.split('-')[0]
    for (var j = 0; j < SUPPORTED.length; j++) {
      if (SUPPORTED[j].toLowerCase().split('-')[0] === base) return SUPPORTED[j]
    }
    return null
  }

  /** 解析语言：?lang= → cookie → navigator（仅命中支持列表）→ DEFAULT(en)。 */
  function resolveLang() {
    var fromQuery = null
    try {
      fromQuery = matchSupported(new URLSearchParams(location.search).get('lang'))
    } catch (_) {
      fromQuery = null
    }
    if (fromQuery) {
      writeCookie(COOKIE, fromQuery) // 显式指定 ⇒ 记住
      return fromQuery
    }
    var fromCookie = matchSupported(readCookie(COOKIE))
    if (fromCookie) return fromCookie
    var nav = matchSupported(navigator.language) || matchSupported((navigator.languages || [])[0])
    if (nav) return nav
    return DEFAULT
  }

  var lang = resolveLang()

  /** 取词条（缺 key：回退英文并 warn，**绝不**返回空串或裸 key）。 */
  function lookup(key) {
    var table = DICT[lang] || DICT[DEFAULT]
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
    if (Object.prototype.hasOwnProperty.call(DICT[DEFAULT], key)) {
      console.warn('[i18n] missing key for "' + lang + '": ' + key + ' (fell back to en)')
      return DICT[DEFAULT][key]
    }
    console.warn('[i18n] unknown key: ' + key)
    return key
  }

  /**
   * 翻译：`t('key')`；带占位符时 `t('key', { n: 3, min: 5 })`（词条里写 `{n}` / `{min}`）。
   * ⚠️ 占位符缺参时**原样保留** `{n}`（便于一眼看出漏传，而不是静默变空）。
   */
  function t(key, params) {
    var s = lookup(key)
    if (params) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
      })
    }
    return s
  }

  /** 就地替换：data-i18n（文本）/ data-i18n-attr="attr:key,attr2:key2"（属性）。 */
  function apply(root) {
    var scope = root || document
    var nodes = scope.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'))
    var attrNodes = scope.querySelectorAll('[data-i18n-attr]')
    for (var j = 0; j < attrNodes.length; j++) {
      var pairs = attrNodes[j].getAttribute('data-i18n-attr').split(',')
      for (var k = 0; k < pairs.length; k++) {
        var bits = pairs[k].split(':')
        if (bits.length === 2) attrNodes[j].setAttribute(bits[0].trim(), t(bits[1].trim()))
      }
    }
    document.documentElement.lang = lang
  }

  /** 切换语言：写 cookie → 重新加载（静态页无状态，重载最稳）。 */
  function setLang(next) {
    if (SUPPORTED.indexOf(next) === -1) return
    writeCookie(COOKIE, next)
    location.reload()
  }

  /** 渲染语言下拉（容器标 data-i18n-switch）。 */
  function mountSwitchers() {
    var hosts = document.querySelectorAll('[data-i18n-switch]')
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i]
      host.innerHTML = ''
      var label = host.getAttribute('data-i18n-switch') || ''
      if (label === 'label') {
        var span = document.createElement('span')
        span.className = 'i18n-lang-label'
        span.textContent = t('common.language')
        host.appendChild(span)
      }
      var sel = document.createElement('select')
      sel.className = 'i18n-lang'
      sel.setAttribute('aria-label', t('common.language'))
      var names = { en: 'English', zh: '中文' }
      for (var s = 0; s < SUPPORTED.length; s++) {
        var opt = document.createElement('option')
        opt.value = SUPPORTED[s]
        opt.textContent = names[SUPPORTED[s]] || SUPPORTED[s]
        if (SUPPORTED[s] === lang) opt.selected = true
        sel.appendChild(opt)
      }
      sel.addEventListener('change', function (event) {
        setLang(event.target.value)
      })
      host.appendChild(sel)
    }
  }

  window.I18N = { t: t, lang: lang, supported: SUPPORTED, set: setLang, apply: apply }

  function boot() {
    mountSwitchers()
    apply(document)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
