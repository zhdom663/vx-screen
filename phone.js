/* =========================================================
 * VXPhone —— 小手机体验模块（仿 North小手机）
 * 锁屏密码 / 拨号键盘 / 来电 / FaceTime 通话 / 聊天皮肤
 * 拉黑 / 备注名 / 星空卡片消息 / 悬浮通知
 * ========================================================= */
'use strict';
window.VXPhone = (function () {
  const $ = s => document.querySelector(s);
  const pad2 = n => String(n).padStart(2, '0');

  /* ---------- 通用工具 ---------- */
  function anyChar(id) {
    const p = CHARACTERS.find(c => c.id === id);
    if (p) return { kind: 'preset', c: p, name: p.name, avatar: p.avatar, voice: p.voice };
    const cu = (db.customs || []).find(c => c.id === id);
    if (cu) return { kind: 'custom', c: cu, name: cu.name, avatar: cu.avatar, voice: cu.gender };
    return null;
  }
  function displayNameOf(ch) {
    if (!ch) return '?';
    return (db.remarks && db.remarks[ch.c.id]) || ch.name;
  }
  function isBlockedLocal(id) { return (db.blocked || []).includes(id); }

  /* 伪手机号：由 id 确定性生成（151 XXXX XXXX） */
  function charPhone(id) {
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const s = String(10000000 + (h % 89999999));
    return `151 ${s.slice(0, 4)} ${s.slice(4)}`;
  }
  const LOCS = ['湖北 武汉', '江苏 南京', '上海', '广东 广州', '四川 成都', '北京 朝阳', '浙江 杭州', '英国', '陕西 西安', '湖南 长沙'];
  function charLoc(id) {
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
    return LOCS[h % LOCS.length];
  }

  /* =========================================================
   * 一、锁屏 —— 「输入 TA 的手机密码」
   * ========================================================= */
  let lockBuf = '', lockClockTimer = null, lockPreview = false;
  function updateLockClock() {
    const d = new Date();
    const t = $('#lockTime'); if (t) t.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const dt = $('#lockDate'); if (dt) dt.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
  }
  function updateLockDots() {
    const dots = $$('#lockDots i');
    dots.forEach((d, i) => d.classList.toggle('on', i < lockBuf.length));
  }
  function showLock() {
    const el = $('#lockScreen'); if (!el) return;
    lockBuf = '';
    updateLockDots();
    const err = $('#lockError'); if (err) { err.textContent = ''; err.classList.remove('shake'); }
    const pr = $('#lockPrompt'); if (pr) pr.textContent = '输入密码';
    updateLockClock();
    el.style.display = 'flex';
    document.body.classList.add('locked');
    clearInterval(lockClockTimer); lockClockTimer = setInterval(updateLockClock, 10000);
  }
  function hideLock() {
    const el = $('#lockScreen'); if (!el) return;
    el.classList.add('unlocking');
    setTimeout(() => { el.style.display = 'none'; el.classList.remove('unlocking'); document.body.classList.remove('locked'); }, 450);
    clearInterval(lockClockTimer);
    toast('密码正确，欢迎回来～', 1500);
  }
  function lockKey(k) {
    const err = $('#lockError');
    if (k === 'del') { lockBuf = lockBuf.slice(0, -1); updateLockDots(); return; }
    if (k === 'cancel') {
      lockBuf = ''; updateLockDots();
      if (lockPreview) { lockPreview = false; hideLock(); }  // 预览锁屏时取消可退出
      return;
    }
    if (lockBuf.length >= 5) return;
    lockBuf += k; updateLockDots();
    if (err) err.textContent = '';
    if (lockBuf.length === 5) setTimeout(checkLock, 180);
  }
  function checkLock() {
    if (lockBuf === (db.lock?.password || '12345')) { hideLock(); }
    else {
      const err = $('#lockError');
      if (err) { err.textContent = '密码错误'; err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake'); }
      lockBuf = ''; updateLockDots();
    }
  }

  /* =========================================================
   * 二、拨号键盘 —— 主号/副号 + FaceTime
   * ========================================================= */
  let dialBuf = '', dialLine = 0;
  function fmtDialNum(s) {
    const d = s.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0, 3)} ${d.slice(3)}`;
    return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  }
  function openDialer() {
    closeSheet();
    dialBuf = '';
    renderDialer();
    const el = $('#dialerPage');
    el.classList.add('active'); el.style.display = 'flex';
    $('#tabbar').style.display = 'none';
  }
  function closeDialer() {
    const el = $('#dialerPage');
    el.classList.remove('active'); el.style.display = 'none';
    if (window.VX) { VX.showPage('chats'); }
  }
  function renderDialer() {
    $('#dialerNum').textContent = fmtDialNum(dialBuf);
    const selfNum = charPhone((dialLine === 0 ? 'self_main_' : 'self_sub_') + db.curIdent);
    $('#dialerCur').textContent = `当前${dialLine === 0 ? '主号' : '匿名号'} ${selfNum}`;
    $$('#dialerTabs button').forEach((b, i) => b.classList.toggle('on', i === dialLine));
  }
  function dialKey(k) {
    if (k === 'del') { dialBuf = dialBuf.slice(0, -1); }
    else if (dialBuf.length < 11) { dialBuf += k; }
    $('#dialerNum').textContent = fmtDialNum(dialBuf);
  }
  function dialCall() {
    /* 按拨号前缀匹配角色；无输入时呼叫读屏接收人 */
    const pool = [
      ...CHARACTERS.map(c => c.id),
      ...(db.customs || []).map(c => c.id)
    ].filter(id => !isBlockedLocal(id));
    if (!pool.length) return toast('没有可呼叫的联系人');
    let target = null;
    if (dialBuf) {
      target = pool.find(id => charPhone(id).replace(/\s/g, '').startsWith(dialBuf));
    }
    if (!target) target = db.settings.targetId || pool[0];
    startUnifiedCall(target);
  }

  /* =========================================================
   * 三、FaceTime 通话（统一入口：预设 + 定制）
   * ========================================================= */
  let callSession = null;   // {id, kind}
  let presetCallTimer = null, presetCallStart = 0;

  function activeKind() { return callSession ? callSession.kind : null; }

  function fillCallMeta(ch) {
    const el = $('#callPage');
    el.querySelector('.call-name').textContent = displayNameOf(ch);
    el.querySelector('.call-avatar').src = ch.avatar || (window.VXCustom ? VXCustom.svgLetter(ch.name) : (window.VX ? VX.svgMe() : ''));
    const num = el.querySelector('.call-num'); if (num) num.textContent = charPhone(ch.c.id);
    const loc = el.querySelector('.call-loc'); if (loc) loc.textContent = charLoc(ch.c.id);
  }
  async function startUnifiedCall(id) {
    const ch = anyChar(id);
    if (!ch) return toast('找不到该联系人');
    if (isBlockedLocal(id)) return toast('已拉黑，无法呼叫');
    /* 防重入：通话进行中忽略重复呼叫 */
    const activeCall = $('#callPage');
    if (activeCall && activeCall.classList.contains('active')) return;
    const incActive = $('#incallPage');
    if (incActive && incActive.style.display === 'flex') return;
    closeDialer();
    hideIncoming();
    /* 每次通话静音/免提按钮复位（默认非免提视觉） */
    document.querySelectorAll('#callPage .cc-btn').forEach(b => b.classList.remove('on'));
    callSession = { id, kind: ch.kind, line: dialLine, exch: 0 };
    if (ch.kind === 'custom' && window.VXCustom) {
      fillCallMeta(ch);
      try { VXCustom.startCall(id); }
      catch (err) { toast('通话启动失败，请重试'); }
      return;
    }
    /* ---- 预设角色通话 ---- */
    const el = $('#callPage');
    fillCallMeta(ch);
    const vEl = el.querySelector('.call-video'); if (vEl) vEl.style.display = 'none';
    el.classList.add('active'); el.style.display = 'flex';
    el.querySelector('.call-status').textContent = '正在呼叫…';
    const sp = el.querySelector('.call-speaking'); if (sp) sp.textContent = '';
    setTimeout(() => {
      if (!callSession || callSession.id !== id) return;
      el.querySelector('.call-status').textContent = (dialLine === 1 ? '匿名号 · ' : '') + '已接通 0:00';
      presetCallStart = Date.now();
      clearInterval(presetCallTimer);
      presetCallTimer = setInterval(() => {
        const s = Math.floor((Date.now() - presetCallStart) / 1000);
        const st = $('#callPage .call-status');
        if (st) st.textContent = `${dialLine === 1 ? '匿名号 · ' : ''}已接通 ${Math.floor(s / 60)}:${pad2(s % 60)}`;
      }, 1000);
      presetCallReply(ch.c, '', true);
    }, 2200);
  }
  /* 字幕渲染：识别「原文（中文翻译）」双语格式（视频01同款） */
  function renderSubtitle(sp, text) {
    if (!sp) return;
    const bm = String(text).match(/^(.+?)（(.+?)）$/);
    sp.innerHTML = bm
      ? `${esc(bm[1])}<span class="cs-sub">（${esc(bm[2])}）</span>`
      : esc(text);
  }
  async function presetCallReply(c, userText, isFirst) {
    const el = $('#callPage');
    if (!callSession || callSession.kind !== 'preset' || !el.classList.contains('active')) return;
    const sp = el.querySelector('.call-speaking'); if (sp) sp.textContent = '……';
    await new Promise(r => setTimeout(r, 700));
    /* 匿名号身份识破彩蛋（视频01「Sound familiar, North?」同款） */
    callSession.exch = (callSession.exch || 0) + (isFirst ? 0 : 1);
    if (callSession.line === 1 && callSession.exch >= 4 && !callSession.revealed && Math.random() < 0.5) {
      callSession.revealed = true;
      const reveal = Math.random() < 0.5
        ? ['Sound familiar?（这声音，怎么越听越耳熟。）', 'Caught you.（被我抓到了。）']
        : ['换了号我就听不出来了？', '下次用自己的号打过来。'];
      for (const L of reveal) {
        if (!callSession || callSession.kind !== 'preset' || !el.classList.contains('active')) return;
        renderSubtitle(el.querySelector('.call-speaking'), L);
        speakTTS(L.replace(/（.+?）/g, ''), c.voice);
        await new Promise(r => setTimeout(r, 2800));
      }
      callSession.caught = true;
      return;
    }
    let text = '';
    if (db.settings.deepseekKey) {
      try {
        const sys = `你现在在打语音电话。${buildSystemPrompt(c, 'chat')}。电话里说话口语化、自然，一次只说一句（25字内）。` +
          (callSession.line === 1 ? '对方是用陌生号码打来的，你语气保持距离感，像对待陌生人。' : '') +
          '如果对方说英文，你也用英文回，并在同一行末尾用括号加中文翻译，格式：英文原句（中文翻译）。';
        const content = isFirst
          ? `（电话刚接通${callSession.line === 1 ? '，陌生来电，先公事公办地问对方是谁' : ''}，用你的性格打个电话问候）`
          : `（电话里）对方说：${userText}`;
        const raw = await callLLM(sys, [{ role: 'user', content }], 0.9);
        text = (raw && raw.split(/\n+/).map(s => s.trim()).filter(Boolean)[0]) || '';
      } catch (e) { text = ''; }
    }
    if (!text) {
      const bank = { shenmz: ['喂，我听着呢。', '信号还行，你说。'], xunn: ['喂喂！听到啦！', '宝你说，我在听～'] };
      const arr = bank[c.id] || ['嗯，我在。', '说吧，听着呢。'];
      text = userText ? arr[Math.floor(Math.random() * arr.length)] : arr[0];
    }
    if (!callSession || callSession.kind !== 'preset' || !el.classList.contains('active')) return;
    renderSubtitle(el.querySelector('.call-speaking'), text);
    speakTTS(String(text).replace(/（.+?）\s*$/, ''), c.voice);
  }
  function speakTTS(text, voice) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      const vs = speechSynthesis.getVoices();
      const pick = vs.find(v => voice === 'deep_m' ? /male|男/i.test(v.name) : /female|女/i.test(v.name));
      if (pick) u.voice = pick;
      if (voice === 'deep_m') u.pitch = 0.7;
      speechSynthesis.speak(u);
    } catch (e) { }
  }
  function presetCallSend() {
    const input = $('#callInput');
    const text = input.value.trim();
    if (!text || !callSession || callSession.kind !== 'preset') return;
    input.value = '';
    presetCallReply(getChar(callSession.id), text, false);
  }
  function endPresetCall() {
    const el = $('#callPage');
    clearInterval(presetCallTimer); presetCallTimer = null;
    try { speechSynthesis.cancel(); } catch (e) { }
    el.classList.remove('active'); el.style.display = 'none';
    if (callSession && presetCallStart) {
      const sec = Math.floor((Date.now() - presetCallStart) / 1000);
      const id = callSession.id;
      const wasCaught = !!callSession.caught, wasAnon = callSession.line === 1;
      if (!db.chats[id]) db.chats[id] = [];
      pushMessage(id, { id: uid(), from: 'them', type: 'call', text: `通话时长 ${Math.floor(sec / 60)}:${pad2(sec % 60)}`, ts: Date.now() });
      renderChats();
      /* 挂断后 AI 追击消息 + 横幅（视频01同款：挂断后翻屏看到 TA 的消息） */
      setTimeout(async () => {
        let follow = '';
        if (db.settings.deepseekKey) {
          try {
            const raw = await callLLM(buildSystemPrompt(getChar(id), 'chat'), [{ role: 'user', content: `（刚和用户打完一通${wasAnon ? '匿名号' : ''}电话${wasCaught ? '，你在电话里识破了用户假扮的陌生人' : ''}。发一条10~25字的消息，符合你的性格，${wasCaught ? '得意地再戳一下用户' : '回味一下刚才的通话'}。直接输出消息本身）` }], 0.9);
            follow = (raw || '').split(/\n+/).map(s => s.trim()).filter(Boolean)[0] || '';
          } catch (e) { }
        }
        if (!follow) follow = wasCaught ? '还想用匿名号瞒我。' : (wasAnon ? '陌生号，有意思。' : '刚挂电话就想你了。');
        pushMessage(id, { id: uid(), from: 'them', type: 'text', text: follow, ts: Date.now() });
        showBanner(id, follow);
        renderChats();
      }, 2600 + Math.random() * 2200);
    }
    presetCallStart = 0;
    callSession = null;
  }

  /* =========================================================
   * 四、来电 —— 角色随机来电
   * ========================================================= */
  let incallId = null, incallBuzz = null;
  function maybeIncoming() {
    /* 随机手机来电已下线：通话只保留聊天页主动发起的微信语音通话 */
    return;
    const lockEl = $('#lockScreen');
    if (lockEl && lockEl.style.display !== 'none' && lockEl.style.display !== '') return;
    const callEl = $('#callPage');
    if (callEl && callEl.classList.contains('active')) return;
    const incEl = $('#incallPage');
    if (incEl && incEl.style.display === 'flex') return;
    if (Math.random() > 0.05) return;
    const pool = [
      ...CHARACTERS.map(c => c.id),
      ...(db.customs || []).map(c => c.id)
    ].filter(id => !isBlockedLocal(id));
    if (!pool.length) return;
    showIncoming(pool[Math.floor(Math.random() * pool.length)]);
  }
  function showIncoming(id) {
    const ch = anyChar(id); if (!ch) return;
    incallId = id;
    $('#incName').textContent = displayNameOf(ch);
    $('#incAv').src = ch.avatar || (window.VXCustom ? VXCustom.svgLetter(ch.name) : (window.VX ? VX.svgMe() : ''));
    $('#incNum').textContent = charPhone(id);
    $('#incLoc').textContent = charLoc(id);
    const el = $('#incallPage');
    el.style.display = 'flex';
    clearInterval(incallBuzz);
    incallBuzz = setInterval(() => el.classList.toggle('buzz'), 900);
  }
  function hideIncoming() {
    const el = $('#incallPage');
    if (!el || el.style.display === 'none') return;
    el.style.display = 'none';
    clearInterval(incallBuzz); incallBuzz = null;
  }
  function answerIncoming() {
    const id = incallId;
    hideIncoming();
    if (!id) return;
    /* 略延迟再拉起通话页，避开来电 UI 拆卸；异常兜底提示，保证点接听一定有反应 */
    setTimeout(() => {
      try { startUnifiedCall(id); }
      catch (e) { toast('接听失败，请从聊天页重新呼叫'); }
    }, 80);
  }
  function rejectIncoming() {
    const id = incallId;
    hideIncoming();
    if (!id) return;
    const missText = {
      shenmz: '打你电话怎么不接？忙就说一声。',
      xunn: '宝！为什么不接我电话😭'
    };
    const text = missText[id] || '怎么不接电话。';
    if (CHARACTERS.some(c => c.id === id)) {
      pushMessage(id, { id: uid(), from: 'them', type: 'text', text, ts: Date.now() });
      if (window.VX) { VX.renderChats(); }
      showBanner(id, text);
    }
  }

  /* =========================================================
   * 五、聊天菜单（备注 / 皮肤 / 背景 / 呼叫 / 拉黑）
   * ========================================================= */
  const SKINS = [['pink', '粉色微信'], ['green', '经典绿泡'], ['white', '纯白气泡'], ['imessage', 'iMessage']];
  let menuCharId = null;
  function openChatMenu(id) {
    const ch = anyChar(id); if (!ch) return;
    menuCharId = id;
    const blocked = isBlockedLocal(id);
    const remark = (db.remarks && db.remarks[id]) || '';
    const skinBtns = SKINS.map(([k, label]) =>
      `<button class="skin-opt ${db.skin === k ? 'on' : ''}" data-act="set-skin" data-v="${k}">
        <i class="skin-dot ${k}"></i>${label}</button>`).join('');
    /* 微信同款：聊天设置开全屏子页，不再是底部弹层 */
    window.VX.openSubPage(`聊天设置`, `
      <div class="wiz-label">备注名</div>
      <div style="display:flex;gap:8px">
        <input class="wiz-input" id="remarkInput" value="${esc(remark)}" placeholder="给TA起个备注（如：小熊先生[^]_[^]）">
        <button class="wiz-btn" style="margin:0;width:84px;flex:0 0 84px" data-act="save-remark">保存</button>
      </div>
      <div class="wiz-label">聊天皮肤</div>
      <div class="skin-grid">${skinBtns}</div>
      <button class="wiz-btn blue" data-act="menu-call" style="margin-top:18px">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:-3px;margin-right:6px"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>呼叫 TA（FaceTime）
      </button>
      <button class="wiz-btn ${blocked ? '' : 'ghost'}" data-act="menu-block" style="margin-top:10px">${blocked ? '解除拉黑（TA 会察觉）' : '拉黑 TA（TA 将无法给你发消息）'}</button>
      <button class="wiz-btn ghost" data-act="menu-delfriend" style="margin-top:10px">删除好友</button>`);
  }
  function saveRemark() {
    if (!menuCharId) return;
    const v = $('#remarkInput').value.trim();
    if (v) db.remarks = Object.assign({}, db.remarks, { [menuCharId]: v });
    else if (db.remarks) delete db.remarks[menuCharId];
    save();
    toast('备注已更新');
    if (window.VX) { VX.renderChats(); }
    const ch = anyChar(menuCharId);
    if (ch && ch.kind === 'preset') {
      const nm = v || ch.name;
      const el = $('#crName'); if (el && currentChat === menuCharId) el.textContent = nm;
    }
    if (window.VX && VX.closeSubPage) VX.closeSubPage();
  }
  function setSkin(k) {
    db.skin = k;
    save();
    applySkin();
    $$('.skin-opt').forEach(b => b.classList.toggle('on', b.dataset.v === k));
    toast('皮肤已切换：' + (SKINS.find(s => s[0] === k) || [])[1]);
  }
  function applySkin() {
    const cls = ['skin-green', 'skin-white', 'skin-imessage'];
    ['#chatroom', '#customChat'].forEach(sel => {
      const el = $(sel); if (!el) return;
      el.classList.remove(...cls);
      if (db.skin && db.skin !== 'pink') el.classList.add('skin-' + db.skin);
      const sc = el.querySelector('.chat-scroll');
      if (sc) sc.style.backgroundImage = '';
    });
  }
  async function toggleBlock() {
    if (!menuCharId) return;
    const id = menuCharId;
    const ch = anyChar(id); if (!ch) return;
    if (window.VX && VX.closeSubPage) VX.closeSubPage();
    if (isBlockedLocal(id)) {
      /* 解除拉黑：角色立刻察觉并质问 */
      db.blocked = db.blocked.filter(x => x !== id);
      save();
      if (window.VX) VX.renderChats();
      const confront = {
        shenmz: ['解除拉黑了？', '说说吧，刚才怎么回事。'],
        xunn: ['宝你刚是不是把我拉黑了！', '我消息都发不出去😭', '哼，补偿我一杯奶茶。']
      };
      if (ch.kind === 'preset') {
        let lines = null;
        if (db.settings.deepseekKey) {
          try {
            const sys = `${buildSystemPrompt(ch.c, 'chat')}`;
            const raw = await callLLM(sys, [{ role: 'user', content: `你刚刚发现用户把你从黑名单里移出来了——也就是说刚才你被拉黑了。按你的性格，发2-3条质问/委屈/生气的消息，口语化，保持人设。` }], 0.95);
            lines = raw ? raw.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 3) : null;
          } catch (e) { lines = null; }
        }
        if (!lines || !lines.length) lines = confront[id] || ['刚才是把我拉黑了？', '说说，怎么回事。'];
        lines.forEach((l, i) => setTimeout(() => {
          pushMessage(id, { id: uid(), from: 'them', type: 'text', text: l, ts: Date.now() });
          if (window.VX) VX.renderChats();
          if (i === lines.length - 1) showBanner(id, l);
        }, i * 900));
      } else {
        /* 定制角色：直接写入一条质问消息 */
        setTimeout(() => {
          const cu = db.customs.find(c => c.id === id);
          if (cu) {
            cu.chats.push({ id: Date.now(), from: 'them', type: 'text', text: '刚才是把我拉黑了？说说，怎么回事。', ts: Date.now() });
            save();
            showBanner(id, '刚才是把我拉黑了？');
          }
        }, 600);
      }
      toast('已解除拉黑');
    } else {
      db.blocked = db.blocked.concat(id);
      save();
      if (window.VX) VX.renderChats();
      toast('已拉黑，TA 的消息将无法送达');
    }
  }

  /* =========================================================
   * 六、悬浮通知横幅（聊天列表顶部）
   * ========================================================= */
  let bannerTimer = null;
  function showBanner(charId, text) {
    const el = $('#floatBanner'); if (!el) return;
    const ch = anyChar(charId); if (!ch) return;
    $('#fbAv').src = ch.avatar || (window.VX ? VX.svgMe() : '');
    $('#fbName').textContent = displayNameOf(ch);
    $('#fbText').textContent = String(text || '').slice(0, 40);
    el.dataset.char = charId;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  /* =========================================================
   * 七、锁屏设置
   * ========================================================= */
  function openLockSettings() {
    (window.VX ? VX.openSubPage : null)('锁屏设置', `
        <div class="wx-row" style="background:transparent;padding-left:0;padding-right:0;border-bottom:none">
          <span style="font-size:15px">开屏锁屏</span>
          <span class="switch ${db.lock.enabled ? 'on' : ''}" data-act="lock-toggle"><i></i></span>
        </div>
        <p style="font-size:12px;color:#888;line-height:1.7;margin-top:8px">开启后每次进入都要输入手机密码，默认 <b>12345</b>。</p>
        <div class="wiz-label">密码（5 位数字）</div>
        <div style="display:flex;gap:8px">
          <input class="wiz-input" id="lockPwd" maxlength="5" inputmode="numeric" value="${esc(db.lock.password || '12345')}">
          <button class="wiz-btn" style="margin:0;width:84px;flex:0 0 84px" data-act="lock-save">保存</button>
        </div>
        <button class="wiz-btn ghost" data-act="lock-now" style="margin-top:14px">立即预览锁屏</button>`);
  }

  /* =========================================================
   * 八、事件监听
   * ========================================================= */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    switch (el.dataset.act) {
      case 'lock-key': lockKey(el.dataset.k); break;
      case 'open-dialer': openDialer(); break;
      case 'dialer-back': closeDialer(); break;
      case 'dial-line':
        dialLine = +el.dataset.v;
        renderDialer();
        break;
      case 'dial-key': dialKey(el.dataset.k); break;
      case 'dial-call': dialCall(); break;
      case 'banner-open': {
        const id = $('#floatBanner').dataset.char;
        $('#floatBanner').classList.remove('show');
        if (id) { closeSheet(); openChat(id); }
        break;
      }
      case 'chat-menu': if (currentChat) openChatMenu(currentChat); break;
      case 'cc-chat-menu': if (window.VXCustom && VXCustom.current) openChatMenu(VXCustom.current); break;
      case 'save-remark': saveRemark(); break;
      case 'set-skin': setSkin(el.dataset.v); break;
      case 'menu-call': if (menuCharId) { if (window.VX && VX.closeSubPage) VX.closeSubPage(); startUnifiedCall(menuCharId); } break;
      case 'menu-block': toggleBlock(); break;
      case 'menu-delfriend': {
        if (!menuCharId) break;
        const cu0 = (db.customs || []).find(c => c.id === menuCharId);
        if (!cu0) { toast('预设角色暂不支持删除'); break; }
        openSheet(`<div class="sheet-head"><b>删除好友</b><button data-act="close-sheet">关闭</button></div>
          <div class="sheet-body">
            <p style="font-size:13px;color:#888;line-height:1.7">将删除与「${esc(cu0.name)}」的好友关系和全部聊天记录，不可恢复。</p>
            <button class="wiz-btn" data-act="confirm-delfriend" style="margin-top:12px">删除</button>
            <button class="wiz-btn ghost" data-act="close-sheet" style="margin-top:10px">取消</button>
          </div>`);
        break;
      }
      case 'confirm-delfriend': {
        const delId = menuCharId;
        if (!delId) break;
        db.customs = (db.customs || []).filter(c => c.id !== delId);
        db.friendReqs = (db.friendReqs || []).filter(r => r.customId !== delId);
        /* 同步清理此人朋友圈：TA 发的圈、TA 的点赞和评论一并删除 */
        db.moments = (db.moments || []).filter(m => !(m.authorType === 'custom' && m.authorId === delId));
        db.moments.forEach(m => {
          m.likes = (m.likes || []).filter(x => x !== delId);
          m.comments = (m.comments || []).filter(c => c.from !== delId);
        });
        save();
        closeSheet();
        if (window.VX && VX.closeSubPage) VX.closeSubPage();
        const ccEl = document.getElementById('customChat');
        if (ccEl && ccEl.classList.contains('active')) {
          ccEl.classList.remove('active');
          ccEl.style.display = 'none';
          document.getElementById('tabbar').style.display = 'flex';
        }
        if (window.VX) { VX.renderChats(); VX.updateBadges && VX.updateBadges(); }
        if (window.VXMoments) VXMoments.render && VXMoments.render();
        toast('已删除该好友');
        break;
      }
      case 'inc-answer': answerIncoming(); break;
      case 'inc-reject': rejectIncoming(); break;
      case 'open-lockset': openLockSettings(); break;
      case 'lock-toggle':
        db.lock.enabled = !db.lock.enabled; save();
        el.classList.toggle('on', db.lock.enabled);
        break;
      case 'lock-save': {
        const v = $('#lockPwd').value.replace(/\D/g, '').slice(0, 5);
        db.lock.password = v || '12345'; save();
        toast('锁屏密码已保存');
        break;
      }
      case 'lock-now': if (window.VX && VX.closeSubPage) VX.closeSubPage(); showLock(); lockPreview = true; break;
      case 'call-send-text':
        if (callSession && callSession.kind === 'preset') { e.stopImmediatePropagation(); presetCallSend(); }
        break;
      case 'end-call':
        if (callSession && callSession.kind === 'preset') { e.stopImmediatePropagation(); endPresetCall(); }
        break;
    }
  });

  /* 通话控制键：静音 / 免提（微信风视觉反馈） */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-cact]');
    if (!el) return;
    const on = el.classList.toggle('on');
    if (el.dataset.cact === 'mute') toast(on ? '已静音' : '已取消静音');
    if (el.dataset.cact === 'speaker') toast(on ? '已开启免提' : '已关闭免提');
  });

  /* 物理键盘支持：锁屏 & 拨号盘可直接打数字 */
  document.addEventListener('keydown', e => {
    const lockEl = $('#lockScreen');
    if (lockEl && lockEl.style.display !== 'none' && lockEl.style.display !== '') {
      if (/^[0-9]$/.test(e.key)) { lockKey(e.key); e.preventDefault(); return; }
      if (e.key === 'Backspace') { lockKey('del'); e.preventDefault(); return; }
      if (e.key === 'Escape') { lockKey('cancel'); return; }
      return;
    }
    const dialEl = $('#dialerPage');
    if (dialEl && dialEl.style.display !== 'none') {
      if (/^[0-9]$/.test(e.key)) { dialKey(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { dialKey('del'); e.preventDefault(); }
      else if (e.key === 'Enter') { dialCall(); e.preventDefault(); }
    }
  });

  /* =========================================================
   * 九、启动 & 定时器
   * ========================================================= */
  function migrate() {
    if (!db.lock || typeof db.lock !== 'object') db.lock = { enabled: true, password: '12345' };
    if (typeof db.lock.enabled !== 'boolean') db.lock.enabled = true;
    if (!db.lock.password) db.lock.password = '12345';
    if (!db.skin) db.skin = 'pink';
    if (typeof db.skin !== 'string') db.skin = 'pink';
    if (!db.remarks || typeof db.remarks !== 'object') db.remarks = {};
    if (!Array.isArray(db.blocked)) db.blocked = [];
    save();
  }
  function boot() {
    migrate();
    applySkin();
    if (db.lock.enabled) showLock();
    setInterval(maybeIncoming, 45000);
  }
  boot();

  /* 对外接口 */
  return {
    showLock, hideLock, openDialer, startUnifiedCall, showBanner,
    applySkin, openChatMenu, activeKind,
    charPhone, charLoc, displayNameOf, anyChar, isBlocked: isBlockedLocal,
    migrate
  };
})();
