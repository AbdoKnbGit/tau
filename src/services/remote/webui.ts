/**
 * The phone-facing client, inlined as a single self-contained HTML document.
 *
 * Inlined on purpose: no bundler step, no static asset directory to ship in
 * the npm tarball, and no second request to get wrong. The page is inert
 * without the token in its fragment, so serving it unauthenticated is safe.
 *
 * Styling follows DESIGN-claude.md: cream canvas floor, warm coral reserved
 * for primary CTAs, dark navy surfaces for code and tool output (the doc's
 * cream-to-dark pacing), serif display at weight 400 with negative tracking,
 * humanist sans body, JetBrains Mono for code. Fonts resolve from local stacks
 * only — a phone on a slow link must not wait on a font CDN to read a plan.
 *
 * Two rules when editing the embedded script:
 *   - no JS template literals, so this file stays one plain TS template
 *     literal without escaping games;
 *   - any backslash escape intended for the *page* must be doubled here
 *     (`\\n`), or the TS literal consumes it and ships a raw newline.
 */

export const REMOTE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="mobile-web-app-capable" content="yes">
<title>Tau Remote</title>
<style>
  *{box-sizing:border-box}
  :root{
    --canvas:#faf9f5; --surface-soft:#f5f0e8; --surface-card:#efe9de;
    --cream-strong:#e8e0d2;
    --dark:#181715; --dark-elevated:#252320; --dark-soft:#1f1e1b;
    --ink:#141413; --body:#3d3d3a; --body-strong:#252523;
    --muted:#6c6a64; --muted-soft:#8e8b82;
    --hairline:#e6dfd8; --hairline-soft:#ebe6df;
    --primary:#cc785c; --primary-active:#a9583e; --primary-disabled:#e6dfd8;
    --on-primary:#ffffff; --on-dark:#faf9f5; --on-dark-soft:#a09d96;
    --teal:#5db8a6; --amber:#e8a55a;
    --success:#5db872; --warning:#d4a017; --error:#c64545;

    --serif:"Tiempos Headline","Cormorant Garamond","EB Garamond",Garamond,Georgia,"Times New Roman",serif;
    --sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

    --r-sm:6px; --r-md:8px; --r-lg:12px; --r-xl:16px; --r-pill:9999px;
  }
  /* Dark uses the system's own documented dark surfaces; coral is unchanged. */
  @media (prefers-color-scheme: dark){
    :root{
      --canvas:#181715; --surface-soft:#1f1e1b; --surface-card:#252320;
      --cream-strong:#2e2b27;
      --dark:#121110; --dark-elevated:#252320; --dark-soft:#1a1917;
      --ink:#faf9f5; --body:#d8d4cb; --body-strong:#eeebe4;
      --muted:#a09d96; --muted-soft:#84817a;
      --hairline:#33302b; --hairline-soft:#2a2723;
      --primary-disabled:#3a3630;
    }
  }

  html,body{margin:0;padding:0;height:100%;overscroll-behavior:none}
  body{
    background:var(--canvas);color:var(--body);
    font:400 16px/1.55 var(--sans);
    display:flex;flex-direction:column;height:var(--vh,100dvh);
    -webkit-font-smoothing:antialiased;
  }

  /* ---- top nav ---- */
  header{
    flex:0 0 auto;display:flex;align-items:center;gap:10px;
    padding:calc(env(safe-area-inset-top) + 12px) 16px 12px;
    background:var(--canvas);border-bottom:1px solid var(--hairline);
  }
  .mark{flex:0 0 auto;width:16px;height:16px;color:var(--ink)}
  .hmeta{flex:1 1 auto;min-width:0}
  .hname{
    font-family:var(--serif);font-size:19px;font-weight:400;letter-spacing:-.3px;
    color:var(--ink);line-height:1.2;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .hsub{
    font-size:12px;font-weight:500;color:var(--muted-soft);line-height:1.4;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .dot{width:7px;height:7px;border-radius:var(--r-pill);background:var(--warning);flex:0 0 auto}
  .dot.ok{background:var(--success)} .dot.off{background:var(--error)}

  /* ---- transcript ---- */
  main{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 16px 8px}
  .msg{margin:0 0 16px;word-wrap:break-word;overflow-wrap:anywhere}
  .msg.user{
    background:var(--cream-strong);color:var(--ink);
    padding:10px 14px;border-radius:var(--r-lg);
    margin-left:auto;max-width:86%;width:fit-content;white-space:pre-wrap;
  }
  .msg.assistant{max-width:100%;color:var(--body);white-space:pre-wrap}
  .msg.sys{
    color:var(--muted);font:400 13px/1.6 var(--mono);
    background:var(--surface-card);border-radius:var(--r-md);padding:10px 12px;
    white-space:pre-wrap;
  }
  /* code-window-card — the doc's signature dark surface */
  .msg pre{
    background:var(--dark);color:var(--on-dark);
    border-radius:var(--r-lg);padding:14px;margin:12px 0;
    overflow-x:auto;font:400 13px/1.6 var(--mono);
  }
  .msg code{
    font:400 .9em/1.5 var(--mono);
    background:var(--surface-card);color:var(--body-strong);
    padding:1px 5px;border-radius:var(--r-sm);
  }
  .msg pre code{background:none;padding:0;color:inherit}

  /* ---- thinking ---- */
  .think{
    margin:0 0 14px;color:var(--muted-soft);font:400 14px/1.6 var(--sans);
    font-style:italic;border-left:2px solid var(--hairline);padding-left:12px;
    cursor:pointer;max-height:3.2em;overflow:hidden;position:relative;white-space:pre-wrap;
  }
  .think.open{max-height:none}
  .think::after{content:'';position:absolute;inset:auto 0 0 0;height:1.4em;
    background:linear-gradient(transparent,var(--canvas))}
  .think.open::after{display:none}

  /* ---- tool cards (feature-card cream, dark output) ---- */
  .tool{
    background:var(--surface-card);border-radius:var(--r-lg);
    margin:0 0 14px;overflow:hidden;
  }
  .tool-h{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer}
  .tool-g{flex:0 0 auto;width:14px;text-align:center;color:var(--primary);
    font:400 13px/1 var(--mono)}
  .tool-n{flex:0 0 auto;font:500 14px/1.4 var(--sans);color:var(--ink)}
  .tool-d{flex:1 1 auto;min-width:0;font:400 12px/1.5 var(--mono);color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tool-s{flex:0 0 auto;font-size:13px;color:var(--muted-soft)}
  .tool-s.ok{color:var(--success)} .tool-s.err{color:var(--error)}
  .tool-b{display:none;background:var(--dark);color:var(--on-dark);
    padding:12px 14px;font:400 12.5px/1.6 var(--mono);
    white-space:pre-wrap;word-break:break-all;max-height:46vh;overflow:auto}
  .tool.open .tool-b{display:block}
  .tool.open .tool-d{white-space:pre-wrap;overflow:visible;text-overflow:clip}
  .tool-b .lbl{display:block;color:var(--on-dark-soft);
    font:500 11px/1.4 var(--sans);letter-spacing:1.5px;text-transform:uppercase;
    margin:0 0 4px}
  .tool-b .lbl+.lbl{margin-top:12px}
  .tool-b .bad{color:#f0a0a0}

  /* ---- images ---- */
  .shot{margin:0 0 14px}
  .shot img{
    display:block;width:100%;height:auto;border-radius:var(--r-lg);
    background:var(--surface-card);cursor:zoom-in;
  }
  .shot.zoom{position:fixed;inset:0;z-index:20;margin:0;background:var(--dark);
    display:flex;align-items:center;justify-content:center;padding:8px}
  .shot.zoom img{width:auto;max-width:100%;max-height:100%;border-radius:0;cursor:zoom-out}
  .shot .broken{
    font:400 13px var(--sans);color:var(--muted);background:var(--surface-card);
    border-radius:var(--r-lg);padding:12px 14px;
  }

  /* ---- command palette ---- */
  #palette{
    position:absolute;left:0;right:0;bottom:100%;max-height:46vh;overflow-y:auto;
    background:var(--canvas);border-top:1px solid var(--hairline);
    box-shadow:0 -8px 24px rgba(20,20,19,.10);display:none;
  }
  #palette.on{display:block}
  .cmd{
    display:block;width:100%;text-align:left;background:none;border:0;
    height:auto;border-radius:0;padding:11px 16px;cursor:pointer;
    border-bottom:1px solid var(--hairline-soft);
  }
  .cmd:active{background:var(--surface-card)}
  .cmd.off{cursor:default;opacity:.55}
  .cmd-n{font:500 15px/1.3 var(--mono);color:var(--ink);display:block}
  .cmd.off .cmd-n{color:var(--muted)}
  .cmd-d{font:400 13px/1.45 var(--sans);color:var(--muted);display:block;margin-top:2px}
  .cmd-r{font:500 11px/1.4 var(--sans);color:var(--muted-soft);
    letter-spacing:1.5px;text-transform:uppercase;display:block;margin-top:3px}
  .cmd-none{padding:14px 16px;font:400 14px var(--sans);color:var(--muted)}

  /* ---- interactive panel ---- */
  #asks{flex:0 0 auto;max-height:66vh;overflow-y:auto;background:var(--canvas);
    border-top:1px solid var(--hairline)}
  .ask{padding:16px}
  .ask+.ask{border-top:1px solid var(--hairline-soft)}
  .badge{
    display:inline-block;background:var(--primary);color:var(--on-primary);
    font:500 12px/1.4 var(--sans);letter-spacing:1.5px;text-transform:uppercase;
    border-radius:var(--r-pill);padding:4px 12px;margin:0 0 10px;
  }
  .badge.pill{background:var(--surface-card);color:var(--ink);letter-spacing:0;
    font-size:13px;text-transform:none}
  .ask-t{
    font-family:var(--serif);font-size:24px;font-weight:400;letter-spacing:-.3px;
    line-height:1.2;color:var(--ink);margin:0 0 8px;
  }
  .ask-d{font-size:15px;color:var(--body);margin:0 0 12px}
  .ask-code{
    background:var(--dark);color:var(--on-dark);border-radius:var(--r-lg);
    padding:12px 14px;font:400 12.5px/1.6 var(--mono);
    white-space:pre-wrap;word-break:break-all;max-height:24vh;overflow:auto;margin:0 0 14px;
  }
  .ask-plan{
    background:var(--surface-card);border-radius:var(--r-lg);padding:14px;
    font-size:14.5px;line-height:1.6;color:var(--body);
    max-height:34vh;overflow:auto;margin:0 0 14px;white-space:pre-wrap;
  }
  .ask-plan pre{background:var(--dark);color:var(--on-dark);border-radius:var(--r-md);
    padding:10px;overflow-x:auto;font:400 12px/1.6 var(--mono);margin:8px 0}
  .ask-plan code{font:400 .9em var(--mono);background:var(--cream-strong);
    padding:1px 4px;border-radius:4px}
  .ask-plan pre code{background:none;padding:0;color:inherit}

  .q{margin:0 0 18px}
  .q-t{font:500 17px/1.4 var(--sans);color:var(--ink);margin:0 0 10px}
  /* connector-tile: canvas + hairline, whole tile tappable */
  .opt{
    display:block;width:100%;text-align:left;background:var(--canvas);
    border:1px solid var(--hairline);border-radius:var(--r-lg);
    /* height:auto is load-bearing — the global button rule pins 44px, which
       clips the description and overlaps the next tile. */
    height:auto;min-height:44px;
    padding:12px 14px;margin:0 0 8px;cursor:pointer;color:var(--ink);
    font:inherit;-webkit-tap-highlight-color:transparent;
  }
  .opt:active{background:var(--surface-card)}
  .opt.on{border-color:var(--primary);background:var(--cream-strong)}
  .opt-l{font:500 15px/1.4 var(--sans);color:var(--ink);display:block}
  .opt-d{font:400 13.5px/1.5 var(--sans);color:var(--muted);display:block;margin-top:3px}
  .opt-other input{
    width:100%;margin-top:8px;background:var(--canvas);color:var(--ink);
    border:1px solid var(--hairline);border-radius:var(--r-md);
    padding:10px 12px;font:400 16px var(--sans);
  }
  .opt-other input:focus{outline:none;border-color:var(--primary);
    box-shadow:0 0 0 3px rgba(204,120,92,.15)}

  .row{display:flex;gap:10px;margin-top:4px}
  .row button{flex:1 1 0}
  .fb{
    width:100%;background:var(--canvas);color:var(--ink);
    border:1px solid var(--hairline);border-radius:var(--r-md);
    padding:10px 12px;font:400 16px var(--sans);margin:0 0 10px;resize:none;
  }
  .fb:focus{outline:none;border-color:var(--primary)}

  /* ---- buttons ---- */
  button{
    border:0;border-radius:var(--r-md);height:44px;padding:0 20px;
    font:500 15px/1 var(--sans);cursor:pointer;
    background:var(--primary);color:var(--on-primary);
    -webkit-tap-highlight-color:transparent;
  }
  button:active{background:var(--primary-active)}
  button:disabled{background:var(--primary-disabled);color:var(--muted)}
  button.sec{background:var(--canvas);color:var(--ink);border:1px solid var(--hairline)}
  button.sec:active{background:var(--surface-card)}
  button.danger{background:var(--error);color:#fff}

  /* ---- composer ---- */
  #busy{display:none;color:var(--muted);font:400 14px var(--sans);padding:0 0 14px}
  #busy.on{display:block}
  .blink{animation:b 1.1s steps(2,start) infinite}
  @keyframes b{to{opacity:.3}}
  footer{
    flex:0 0 auto;display:flex;gap:10px;align-items:flex-end;
    padding:10px 12px calc(env(safe-area-inset-bottom) + 10px);
    background:var(--canvas);border-top:1px solid var(--hairline);
  }
  textarea#box{
    flex:1 1 auto;resize:none;max-height:34vh;min-height:44px;
    background:var(--canvas);color:var(--ink);
    border:1px solid var(--hairline);border-radius:var(--r-md);
    padding:12px 14px;font:400 16px/1.5 var(--sans);
  }
  textarea#box:focus{outline:none;border-color:var(--primary);
    box-shadow:0 0 0 3px rgba(204,120,92,.15)}
  #send{flex:0 0 auto}

  #banner{display:none;padding:10px 16px;background:var(--amber);color:var(--ink);
    font:500 13px var(--sans);text-align:center}
  #banner.on{display:block}
</style>
</head>
<body>
<div id="banner"></div>
<header>
  <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="currentColor">
      <rect x="10.8" y="1" width="2.4" height="22" rx="1.2"/>
      <rect x="10.8" y="1" width="2.4" height="22" rx="1.2" transform="rotate(60 12 12)"/>
      <rect x="10.8" y="1" width="2.4" height="22" rx="1.2" transform="rotate(120 12 12)"/>
    </g>
  </svg>
  <span class="hmeta">
    <div class="hname" id="cwd">Tau</div>
    <div class="hsub" id="sub">connecting…</div>
  </span>
  <span class="dot" id="dot"></span>
</header>
<main id="log"></main>
<div id="asks"></div>
<footer style="position:relative">
  <div id="palette"></div>
  <textarea id="box" rows="1" placeholder="Reply to Tau…" autocapitalize="sentences"></textarea>
  <button id="send">Send</button>
</footer>
<script>
(function(){
  var log=document.getElementById('log'), box=document.getElementById('box'),
      send=document.getElementById('send'), dot=document.getElementById('dot'),
      cwdEl=document.getElementById('cwd'), subEl=document.getElementById('sub'),
      banner=document.getElementById('banner'), asksEl=document.getElementById('asks'),
      palette=document.getElementById('palette');
  var token=location.hash.slice(1), ws=null, busy=false, retry=0;
  var FENCE=String.fromCharCode(96,96,96), TICK=String.fromCharCode(96);
  var cards={}, asks={}, model='', commands=[];

  var GLYPH={Bash:'$',Read:'\\u25a4',Edit:'\\u270e',Write:'\\u270e',NotebookEdit:'\\u270e',
    Grep:'\\u2315',Glob:'\\u2315',Task:'\\u25c7',WebFetch:'\\u2193',WebSearch:'\\u2315',
    Skill:'\\u2726',TodoWrite:'\\u2611',AskUserQuestion:'?',ExitPlanMode:'\\u25b6'};

  function fitViewport(){
    var vv=window.visualViewport;
    if(vv) document.documentElement.style.setProperty('--vh', vv.height+'px');
  }
  if(window.visualViewport){
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  fitViewport();

  function atBottom(){ return log.scrollHeight-log.scrollTop-log.clientHeight < 140; }
  function toBottom(){ log.scrollTop=log.scrollHeight; }
  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function el(tag, cls, text){
    var n=document.createElement(tag);
    if(cls) n.className=cls;
    if(text!=null) n.textContent=text;
    return n;
  }

  // Minimal, safe markdown: fenced blocks and inline code. Everything is
  // escaped first, so no model output can inject markup.
  function render(text){
    var parts=String(text).split(FENCE), out='', i, body;
    for(i=0;i<parts.length;i++){
      if(i%2===1){
        body=parts[i].replace(/^[a-zA-Z0-9+#.-]*\\n/,'');
        out+='<pre><code>'+esc(body)+'</code></pre>';
      } else {
        out+=esc(parts[i]).replace(new RegExp(TICK+'([^'+TICK+'\\n]+)'+TICK,'g'),'<code>$1</code>');
      }
    }
    return out;
  }

  // For a path the tail identifies it; for a command the head does. CSS
  // ellipsis always eats the tail, and direction:rtl fixes that but reorders
  // leading punctuation (".github/…" renders as "github/….") — so clip here.
  function clip(text){
    var LIMIT=52;
    if(text.length<=LIMIT) return text;
    var isPath = text.indexOf('/')>=0 || text.indexOf('\\\\')>=0;
    return isPath ? '\\u2026'+text.slice(-(LIMIT-1)) : text;
  }

  var busyEl=el('div',null,null);
  busyEl.id='busy';
  busyEl.innerHTML='<span class="blink">working…</span>';

  // Images are fetched by content-hash id rather than inlined in the
  // transcript, so a reconnect replays ids instead of megabytes of base64 and
  // the browser serves them from cache.
  function addImage(item){
    var wrap=el('div','shot');
    var img=document.createElement('img');
    img.src='/img/'+encodeURIComponent(item.id)+'?t='+encodeURIComponent(token);
    img.alt='screenshot';
    img.loading='lazy';
    img.addEventListener('click', function(){ wrap.classList.toggle('zoom'); });
    // An evicted image 404s; say so rather than showing a broken-image icon.
    img.addEventListener('error', function(){
      wrap.innerHTML='';
      wrap.appendChild(el('div','broken','\\u26a0 image no longer available'));
    });
    wrap.appendChild(img);
    return wrap;
  }

  function addTool(item){
    var card=el('div','tool');
    var head=el('div','tool-h');
    head.appendChild(el('span','tool-g', GLYPH[item.name]||'\\u2022'));
    head.appendChild(el('span','tool-n', item.name));
    head.appendChild(el('span','tool-d', clip(item.detail||'')));
    var status=el('span','tool-s','\\u00b7\\u00b7\\u00b7');
    head.appendChild(status);
    var body=el('div','tool-b');
    if(item.detail){
      body.appendChild(el('span','lbl','input'));
      body.appendChild(document.createTextNode(item.detail));
    }
    head.addEventListener('click', function(){ card.classList.toggle('open'); });
    card.appendChild(head); card.appendChild(body);
    if(item.id) cards[item.id]={card:card, status:status, body:body};
    return card;
  }

  function fillResult(item){
    var c=cards[item.id];
    if(!c) return;
    c.status.textContent = item.ok ? '\\u2713' : '\\u2715';
    c.status.className = 'tool-s '+(item.ok?'ok':'err');
    if(item.text){
      c.body.appendChild(el('span','lbl','output'));
      c.body.appendChild(el('div', item.ok?null:'bad', item.text));
    }
  }

  function add(item){
    var stick=atBottom(), node;
    if(item.kind==='tool'){ node=addTool(item); }
    else if(item.kind==='image'){ node=addImage(item); }
    else if(item.kind==='result'){ fillResult(item); if(stick) toBottom(); return; }
    else if(item.kind==='thinking'){
      node=el('div','think', item.text);
      node.addEventListener('click', function(){ node.classList.toggle('open'); });
    }
    else if(item.kind==='sys'){ node=el('div','msg sys', item.text); }
    else if(item.kind==='user'){ node=el('div','msg user', item.text); }
    else { node=el('div','msg assistant'); node.innerHTML=render(item.text); }
    log.appendChild(node);
    if(busy) log.appendChild(busyEl);
    if(stick) toBottom();
  }

  function setBusy(b){
    busy=b;
    busyEl.className=b?'on':'';
    if(b) log.appendChild(busyEl);
    send.textContent=b?'Stop':'Send';
    send.className=b?'danger':'';
    if(atBottom()) toBottom();
  }

  // ---- interactive requests -------------------------------------------
  function reply(id, payload){
    if(ws&&ws.readyState===1) ws.send(JSON.stringify({t:'ask-response',id:id,reply:payload}));
    dropAsk(id);
  }
  function dropAsk(id){
    var a=asks[id];
    if(!a) return;
    a.remove();
    delete asks[id];
  }

  function actionRow(denyLabel, allowLabel, onDeny, onAllow){
    var row=el('div','row');
    var no=el('button','sec',denyLabel);
    var yes=el('button',null,allowLabel);
    no.addEventListener('click', onDeny);
    yes.addEventListener('click', onAllow);
    row.appendChild(no); row.appendChild(yes);
    return row;
  }

  function buildPermission(m, card){
    card.appendChild(el('span','badge','Permission'));
    card.appendChild(el('div','ask-t', m.tool));
    if(m.description) card.appendChild(el('div','ask-d', m.description));
    if(m.detail) card.appendChild(el('div','ask-code', m.detail));
    card.appendChild(actionRow('Deny','Allow',
      function(){ reply(m.id,{action:'deny'}); },
      function(){ reply(m.id,{action:'allow'}); }));
  }

  function buildPlan(m, card){
    card.appendChild(el('span','badge','Plan'));
    card.appendChild(el('div','ask-t','Ready to build'));
    var planEl=el('div','ask-plan');
    planEl.innerHTML=render(m.plan||'');
    card.appendChild(planEl);
    var fb=el('textarea','fb');
    fb.rows=2;
    fb.placeholder='Optional: what to change…';
    card.appendChild(fb);
    card.appendChild(actionRow('Keep planning','Approve',
      function(){
        var t=fb.value.trim();
        reply(m.id, t?{action:'deny',feedback:t}:{action:'deny'});
      },
      function(){ reply(m.id,{action:'allow'}); }));
  }

  function buildQuestions(m, card){
    card.appendChild(el('span','badge','Question'));
    var state=[];

    (m.questions||[]).forEach(function(q){
      var wrap=el('div','q');
      if(q.header) wrap.appendChild(el('span','badge pill', q.header));
      wrap.appendChild(el('div','q-t', q.question));

      var picked={}, otherOn=false;
      var buttons=[];

      function sync(){
        buttons.forEach(function(b){
          if(picked[b.dataset.label]) b.classList.add('on');
          else b.classList.remove('on');
        });
        if(otherOn) ob.classList.add('on'); else ob.classList.remove('on');
        otherInput.style.display = otherOn ? 'block' : 'none';
        refreshSubmit();
      }

      (q.options||[]).forEach(function(o){
        var b=el('button','opt');
        b.dataset.label=o.label;
        b.appendChild(el('span','opt-l', o.label));
        if(o.description) b.appendChild(el('span','opt-d', o.description));
        b.addEventListener('click', function(){
          var wasOn=!!picked[o.label];
          if(q.multiSelect){
            if(wasOn) delete picked[o.label]; else picked[o.label]=1;
          } else {
            picked={};
            if(!wasOn) picked[o.label]=1;
            otherOn=false;
          }
          sync();
        });
        buttons.push(b);
        wrap.appendChild(b);
      });

      // "Other" is always available — the tool contract says the user can
      // supply their own answer, so the phone must not be more restrictive
      // than the terminal.
      var other=el('div','opt-other');
      var ob=el('button','opt');
      ob.dataset.label='__other__';
      ob.appendChild(el('span','opt-l','Other'));
      var otherInput=el('input');
      otherInput.type='text';
      otherInput.placeholder='Type your own answer';
      otherInput.style.display='none';
      otherInput.addEventListener('input', refreshSubmit);
      ob.addEventListener('click', function(){
        otherOn=!otherOn;
        if(otherOn && !q.multiSelect) picked={};
        sync();
        if(otherOn) otherInput.focus();
      });
      other.appendChild(ob);
      other.appendChild(otherInput);
      wrap.appendChild(other);

      state.push({q:q, get:function(){
        var vals=Object.keys(picked);
        if(otherOn){
          var t=otherInput.value.trim();
          if(t) vals.push(t);
        }
        return vals;
      }});
      card.appendChild(wrap);
    });

    var row=el('div','row');
    var cancel=el('button','sec','Cancel');
    var submit=el('button',null,'Submit');
    function refreshSubmit(){
      // Every question needs an answer — a partial payload would make the
      // model act on a choice the human never made.
      var ok = state.length>0 && state.every(function(s){ return s.get().length>0; });
      submit.disabled = !ok;
    }
    cancel.addEventListener('click', function(){ reply(m.id,{action:'deny'}); });
    submit.addEventListener('click', function(){
      var answers={};
      state.forEach(function(s){ answers[s.q.question]=s.get().join(', '); });
      reply(m.id,{action:'answers',answers:answers});
    });
    row.appendChild(cancel); row.appendChild(submit);
    card.appendChild(row);
    refreshSubmit();
  }

  function addAsk(m){
    if(asks[m.id]) return;
    var card=el('div','ask');
    if(m.kind==='questions') buildQuestions(m, card);
    else if(m.kind==='plan') buildPlan(m, card);
    else buildPermission(m, card);
    asks[m.id]=card;
    asksEl.appendChild(card);
    asksEl.scrollTop=0;
  }

  function showBanner(msg){
    if(!msg){ banner.className=''; return; }
    banner.textContent=msg; banner.className='on';
  }

  function reset(m){
    log.innerHTML=''; asksEl.innerHTML='';
    cards={}; asks={}; busy=false;
    var base=String(m.cwd||'').split(/[\\\\/]/).filter(Boolean).pop();
    cwdEl.textContent=base||'Tau';
    model=m.model||'';
    subEl.textContent=[model, m.cwd].filter(Boolean).join('  \\u00b7  ');
    commands=Array.isArray(m.commands)?m.commands:[];
    palette.className=''; palette.innerHTML='';
    (m.messages||[]).forEach(add);
    (m.asks||[]).forEach(function(a){ addAsk(flatten(a)); });
    setBusy(!!m.busy);
    toBottom();
  }

  // Wire shape is {id, form:{kind,...}}; the builders take one flat object.
  function flatten(a){
    var out={id:a.id};
    var f=a.form||{};
    for(var k in f){ if(Object.prototype.hasOwnProperty.call(f,k)) out[k]=f[k]; }
    return out;
  }

  function connect(){
    if(!token){ showBanner('Missing access token — rescan the QR code'); return; }
    var proto=location.protocol==='https:'?'wss://':'ws://';
    ws=new WebSocket(proto+location.host+'/ws?t='+encodeURIComponent(token));

    ws.onopen=function(){ retry=0; dot.className='dot ok'; showBanner(''); };

    ws.onmessage=function(ev){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.t==='hello'){ reset(m); }
      else if(m.t==='messages'){ (m.messages||[]).forEach(add); }
      else if(m.t==='state'){ setBusy(!!m.busy); }
      else if(m.t==='ask'){ addAsk(flatten(m)); }
      else if(m.t==='ask-end'){ dropAsk(m.id); }
      else if(m.t==='bye'){ showBanner(m.reason||'Session ended'); }
    };

    ws.onclose=function(ev){
      dot.className='dot off';
      if(ev.code===4003){ showBanner('Access denied — rescan the QR code'); return; }
      retry++;
      showBanner(retry>2?'Reconnecting…':'');
      setTimeout(connect, Math.min(800*retry, 5000));
    };

    ws.onerror=function(){ try{ ws.close(); }catch(e){} };
  }

  function sendPrompt(text){
    if(!text||!ws||ws.readyState!==1) return false;
    ws.send(JSON.stringify({t:'prompt', text:text}));
    box.value=''; box.style.height='auto';
    palette.className=''; palette.innerHTML='';
    toBottom();
    return true;
  }

  function submit(){
    // The main button doubles as Stop while a turn runs — that is what its
    // label says. The palette deliberately does not go through here.
    if(busy){
      if(ws&&ws.readyState===1) ws.send(JSON.stringify({t:'interrupt'}));
      return;
    }
    sendPrompt(box.value.trim());
  }

  // ---- command palette ------------------------------------------------
  // Every command is listed, runnable or not. A phone that silently drops
  // /model is indistinguishable from a broken remote; showing it greyed with
  // "opens a terminal dialog" tells you to go to the keyboard instead.
  function renderPalette(){
    var v=box.value;
    if(v.charAt(0)!=='/' || v.indexOf(' ')>=0 || v.indexOf('\\n')>=0){
      palette.className=''; palette.innerHTML=''; return;
    }
    var q=v.slice(1).toLowerCase();
    var hits=commands.filter(function(c){ return c.name.toLowerCase().indexOf(q)===0; });
    if(hits.length===0){
      hits=commands.filter(function(c){ return c.name.toLowerCase().indexOf(q)>=0; });
    }
    palette.innerHTML='';
    if(hits.length===0){
      palette.appendChild(el('div','cmd-none','No command matches \\u201c'+v+'\\u201d'));
      palette.className='on';
      return;
    }
    hits.slice(0,40).forEach(function(c){
      var b=el('button', c.runnable?'cmd':'cmd off');
      b.appendChild(el('span','cmd-n','/'+c.name+(c.argumentHint?' '+c.argumentHint:'')));
      if(c.description) b.appendChild(el('span','cmd-d', c.description));
      if(!c.runnable && c.reason) b.appendChild(el('span','cmd-r', c.reason));
      if(c.runnable){
        b.addEventListener('click', function(){
          if(c.argumentHint){
            box.value='/'+c.name+' ';
            palette.className=''; palette.innerHTML='';
            box.focus();
            return;
          }
          // Never route through submit(): while busy that branch interrupts
          // the turn instead of running the command.
          if(!sendPrompt('/'+c.name)) box.value='/'+c.name;
        });
      }
      palette.appendChild(b);
    });
    palette.className='on';
  }

  send.addEventListener('click', submit);
  box.addEventListener('input', function(){
    box.style.height='auto';
    box.style.height=Math.min(box.scrollHeight, window.innerHeight*0.34)+'px';
    renderPalette();
  });
  // Enter sends on a hardware keyboard; phones keep the newline key.
  box.addEventListener('keydown', function(e){
    if(e.key==='Enter' && !e.shiftKey && !/Mobi|Android/i.test(navigator.userAgent)){
      e.preventDefault(); submit();
    }
  });

  connect();
})();
</script>
</body>
</html>`
