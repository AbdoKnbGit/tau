// @ts-nocheck
// Tau chat webview. Talks to the extension host over postMessage; the host
// bridges to `tau acp`. All rendering (the "look") lives here.
(function () {
  const vscode = acquireVsCodeApi()
  const $ = sel => document.querySelector(sel)

  const messagesEl = $('#messages')
  const inputEl = $('#input')
  const sendBtn = $('#send')
  const pickersEl = $('#pickers')
  const statusEl = $('#status')
  const cacheBarEl = $('#cachebar')
  const footerEl = $('#footer')

  let running = false
  let lastTextEl = null
  let lastRaw = ''
  let thinkingEl = null
  let commands = []
  let showCacheBar = true
  const toolEls = new Map()

  window.addEventListener('message', e => handle(e.data))
  setupComposer()
  vscode.postMessage({ type: 'ready' })

  // ---- inbound from host ---------------------------------------------------

  function handle(msg) {
    switch (msg.type) {
      case 'config':
        showCacheBar = msg.showCacheBar !== false
        break
      case 'status':
        setStatus(msg.status)
        break
      case 'session':
        renderPickers(msg.configOptions || [])
        break
      case 'commands':
        commands = msg.commands || []
        break
      case 'text':
        appendText(msg.text)
        break
      case 'thought':
        appendThought(msg.text)
        break
      case 'toolCall':
        appendToolCall(msg.call)
        break
      case 'toolUpdate':
        updateToolCall(msg.update)
        break
      case 'usage':
        renderCacheBar(msg.usage)
        break
      case 'turnEnd':
        endTurn()
        break
      case 'error':
        appendError(msg.message)
        endTurn()
        break
      case 'exit':
        appendError('The Tau agent exited' + (msg.code != null ? ` (code ${msg.code})` : '') + '. Use the ↻ button to restart.')
        endTurn()
        break
      case 'reset':
        messagesEl.innerHTML = ''
        toolEls.clear()
        lastTextEl = null
        break
    }
  }

  // ---- rendering -----------------------------------------------------------

  function setStatus(status) {
    const map = {
      starting: ['dot-amber', 'starting…'],
      ready: ['dot-green', 'ready'],
      error: ['dot-red', 'error'],
    }
    const [cls, label] = map[status] || ['dot-amber', status || '']
    statusEl.innerHTML = `<span class="dot ${cls}"></span>${label}`
  }

  function newAgentRow(kind) {
    const row = document.createElement('div')
    row.className = 'row agent'
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = '✷'
    const body = document.createElement('div')
    body.className = 'body ' + (kind || '')
    row.append(avatar, body)
    messagesEl.appendChild(row)
    scrollDown()
    return body
  }

  function appendText(text) {
    if (!text) return
    clearThinking()
    if (!lastTextEl) {
      lastTextEl = newAgentRow('text')
      lastRaw = ''
    }
    lastRaw += text
    lastTextEl.innerHTML = mdToHtml(lastRaw)
    scrollDown()
  }

  function appendThought(text) {
    clearThinking()
    lastTextEl = null
    const body = newAgentRow('thought')
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = '💭 Thought'
    const pre = document.createElement('div')
    pre.className = 'thought-text'
    pre.innerHTML = mdToHtml(text)
    details.append(summary, pre)
    body.appendChild(details)
    scrollDown()
  }

  function appendToolCall(call) {
    clearThinking()
    lastTextEl = null
    const body = newAgentRow('tool')
    const chip = document.createElement('div')
    chip.className = 'tool ' + statusClass(call.status)
    chip.innerHTML =
      `<span class="tool-kind">${kindIcon(call.kind)}</span>` +
      `<span class="tool-title">${escapeHtml(call.title)}</span>` +
      `<span class="tool-status">${escapeHtml(call.status)}</span>`
    const out = document.createElement('pre')
    out.className = 'tool-output hidden'
    body.append(chip, out)
    chip.addEventListener('click', () => out.classList.toggle('hidden'))
    toolEls.set(call.id, { chip, out })
    scrollDown()
  }

  function updateToolCall(update) {
    const el = toolEls.get(update.id)
    if (!el) return
    el.chip.className = 'tool ' + statusClass(update.status)
    const statusSpan = el.chip.querySelector('.tool-status')
    if (statusSpan) statusSpan.textContent = update.status
    if (update.content) {
      el.out.textContent = update.content
      el.out.classList.remove('hidden')
    }
    scrollDown()
  }

  function appendUser(text) {
    const row = document.createElement('div')
    row.className = 'row user'
    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = text
    row.appendChild(body)
    messagesEl.appendChild(row)
    scrollDown()
  }

  function appendError(message) {
    const row = document.createElement('div')
    row.className = 'row error'
    row.textContent = '⚠ ' + message
    messagesEl.appendChild(row)
    scrollDown()
  }

  function showThinking() {
    clearThinking()
    const body = newAgentRow('thinking')
    body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
    thinkingEl = body.parentElement
  }

  function clearThinking() {
    if (thinkingEl) {
      thinkingEl.remove()
      thinkingEl = null
    }
  }

  function renderCacheBar(usage) {
    if (!showCacheBar || !usage) return
    const pct = Math.max(0, Math.min(100, usage.cachePct || 0))
    cacheBarEl.classList.remove('hidden')
    cacheBarEl.innerHTML =
      `<div class="cachebar-fill" style="width:${pct}%"></div>` +
      `<div class="cachebar-label">⚡ ${pct}% cached${usage.cost ? ' · ' + escapeHtml(usage.cost) : ''}</div>`
  }

  function renderPickers(configOptions) {
    pickersEl.innerHTML = ''
    for (const opt of configOptions) {
      const sel = document.createElement('select')
      sel.className = 'picker'
      sel.title = opt.name
      for (const o of opt.options) {
        const el = document.createElement('option')
        el.value = o.value
        el.textContent = o.name
        if (o.value === opt.currentValue) el.selected = true
        sel.appendChild(el)
      }
      sel.addEventListener('change', () =>
        vscode.postMessage({ type: 'setConfig', configId: opt.id, value: sel.value }),
      )
      pickersEl.appendChild(sel)
    }
  }

  // ---- composer ------------------------------------------------------------

  function setupComposer() {
    autoGrow()
    inputEl.addEventListener('input', () => {
      autoGrow()
      maybeShowCommands()
    })
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    })
    sendBtn.addEventListener('click', () => (running ? stop() : submit()))
  }

  function autoGrow() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'
  }

  function submit() {
    const text = inputEl.value.trim()
    if (!text || running) return
    appendUser(text)
    inputEl.value = ''
    autoGrow()
    hideCommandMenu()
    lastTextEl = null
    running = true
    sendBtn.textContent = '■'
    sendBtn.classList.add('stop')
    showThinking()
    vscode.postMessage({ type: 'prompt', text })
  }

  function stop() {
    vscode.postMessage({ type: 'stop' })
  }

  function endTurn() {
    running = false
    clearThinking()
    sendBtn.textContent = '▸'
    sendBtn.classList.remove('stop')
    lastTextEl = null
  }

  // ---- slash command menu --------------------------------------------------

  let menuEl = null
  function maybeShowCommands() {
    const val = inputEl.value
    if (!val.startsWith('/') || val.includes(' ') || commands.length === 0) {
      hideCommandMenu()
      return
    }
    const q = val.slice(1).toLowerCase()
    const matches = commands
      .filter(c => c.name.toLowerCase().includes(q))
      .slice(0, 8)
    if (matches.length === 0) {
      hideCommandMenu()
      return
    }
    if (!menuEl) {
      menuEl = document.createElement('div')
      menuEl.className = 'cmd-menu'
      footerEl.insertBefore(menuEl, footerEl.firstChild)
    }
    menuEl.innerHTML = ''
    for (const c of matches) {
      const item = document.createElement('div')
      item.className = 'cmd-item'
      item.innerHTML = `<span class="cmd-name">/${escapeHtml(c.name)}</span><span class="cmd-desc">${escapeHtml(c.description || '')}</span>`
      item.addEventListener('click', () => {
        inputEl.value = '/' + c.name + ' '
        hideCommandMenu()
        inputEl.focus()
        autoGrow()
      })
      menuEl.appendChild(item)
    }
  }

  function hideCommandMenu() {
    if (menuEl) {
      menuEl.remove()
      menuEl = null
    }
  }

  // ---- helpers -------------------------------------------------------------

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function statusClass(status) {
    if (status === 'completed') return 'ok'
    if (status === 'failed') return 'fail'
    if (status === 'in_progress') return 'busy'
    return 'pending'
  }

  function kindIcon(kind) {
    const map = {
      read: '📖', search: '🔎', edit: '✏️', delete: '🗑', move: '↪',
      execute: '⌘', think: '💭', fetch: '🌐', other: '🔧',
    }
    return map[kind] || '🔧'
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    )
  }

  // Compact, dependency-free markdown (code fences, inline code, bold/italic,
  // headings, lists, paragraphs). Good enough for chat; not a full parser.
  function mdToHtml(src) {
    const fences = []
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      fences.push(`<pre class="code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
      return ` ${fences.length - 1} `
    })
    let html = escapeHtml(src)
    html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    html = html.replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^# (.*)$/gm, '<h2>$1</h2>')
    html = html.replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split('\n')
        .map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')
      return `\n<ul>${items}</ul>`
    })
    html = html.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')
    html = '<p>' + html + '</p>'
    html = html.replace(/<p>(\s*<(?:ul|h[234]|pre)[\s\S]*?<\/(?:ul|h[234]|pre)>\s*)<\/p>/g, '$1')
    html = html.replace(/ (\d+) /g, (_, i) => fences[+i])
    return html
  }
})()
