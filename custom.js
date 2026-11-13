/* ============================================================
 * VX 定制人物模块：29.9 定制 / 好友申请 / 语音 / 通话 / 红包
 * 依赖：window.VX（app.js 暴露的公共接口）
 * ============================================================ */
(function () {
  const { db, save, uid, esc, toast, openSheet, closeSheet, openSubPage, closeSubPage, showPage, renderChats,
    getChar, CHARACTERS, callLLM, buildSystemPrompt, fmtHM, fmtClock, pad2, svgMe, img } = VX;

  /* ---------------- IndexedDB：存视频/录音等大 blob ---------------- */
  let idb = null;
  function openIDB() {
    return new Promise((resolve, reject) => {
      if (idb) return resolve(idb);
      const req = indexedDB.open('vx_media', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onsuccess = () => { idb = req.result; resolve(idb); };
      req.onerror = () => reject(req.error);
    });
  }
  async function putBlob(key, blob) {
    const d = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getBlob(key) {
    const d = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('blobs');
      const req = tx.objectStore('blobs').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  /* 手机浏览器 IndexedDB 可能受限（隐私模式等），所有读取都走安全包装，失败返回 null 不炸通话 */
  async function safeGetBlob(key) {
    try { if (!key || !window.indexedDB) return null; return await getBlob(key); }
    catch (e) { return null; }
  }
  function blobUrl(blob) { return blob ? URL.createObjectURL(blob) : ''; }

  /* ---------------- 头像压缩 ---------------- */
  function compressAvatar(file, max = 256) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const im = new Image();
        im.onload = () => {
          const c = document.createElement('canvas');
          const s = Math.min(max, im.width, im.height);
          c.width = c.height = s;
          const ctx = c.getContext('2d');
          ctx.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, s, s);
          resolve(c.toDataURL('image/jpeg', 0.82));
        };
        im.onerror = () => resolve('');
        im.src = r.result;
      };
      r.onerror = () => resolve('');
      r.readAsDataURL(file);
    });
  }

  /* ---------------- 角色获取 ---------------- */
  function getCustom(id) { return db.customs.find(c => c.id === id); }
  /* 名字首字头像：不上传头像时的默认（微信 initials 风，颜色按名字散列固定） */
  const LETTER_COLORS = ['#ff8fab', '#7b6cff', '#34c759', '#ff9f0a', '#5b8def', '#ff6b6b', '#32ade6', '#af52de'];
  function svgLetter(name) {
    const nm = String(name || 'TA').trim() || 'TA';
    let h = 0; for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) >>> 0;
    const bg = LETTER_COLORS[h % LETTER_COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="14" fill="${bg}"/><text x="48" y="64" font-size="46" text-anchor="middle" fill="#fff" font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif" font-weight="500">${nm.charAt(0)}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function customAvatar(c) { return c.avatar || svgLetter(c.name); }

  /* ---------------- 定制商店 + 29.9 模拟支付 ---------------- */
  function openCustomShop() {
    openSubPage('定制专属陪伴', `
      <div class="shop-hero">
        <div class="shop-title">定制专属陪伴</div>
        <div class="shop-sub">免费试用 3 天 · 永不 OOC</div>
      </div>
      <div class="shop-feat">
        <div class="feat"><b>🎭</b><span>自定义人设、头像、音色</span></div>
        <div class="feat"><b>💬</b><span>加好友后主动找你聊天</span></div>
        <div class="feat"><b>🎙</b><span>文字语音随意切换</span></div>
        <div class="feat"><b>📞</b><span>随时拨打对方电话</span></div>
      </div>
      <div class="shop-price">
        <div class="price-now">¥29.9<span style="font-size:14px;color:#8a8a8e"> /包月 · 免费试用 3 天</span></div>
      </div>
      <div class="tap-hint">👇 点击下方按钮，开始定制你的专属角色</div>
      <button class="wx-primary" data-act="pay-custom">免费试用 3 天</button>`);
  }

  function fakePay() {
    // 免费试用：跳过支付，直接进入定制表单
    toast('试用已开启，开始定制你的专属角色', 1500);
    setTimeout(() => openCustomForm(), 600);
  }

  /* ---------------- 定制表单 ---------------- */
  function openCustomForm() {
    openSubPage('创建你的专属角色', `
      <div class="form-row"><label>头像</label>
        <div class="avatar-upload" data-act="pick-avatar">
          <img id="cvAvatar" src="${svgMe()}"><span>点击上传</span>
        </div>
        <input type="file" id="cvAvatarInput" accept="image/*" hidden>
      </div>
      <div class="form-row"><label>名字</label>
        <input id="cvName" placeholder="给 TA 起个名字" maxlength="10">
      </div>
      <div class="form-row"><label>性别 / 音色</label>
        <select id="cvGender"><option value="female">女生音色</option><option value="male">男生音色</option></select>
      </div>
      <div class="form-row"><label>性格</label>
        <input id="cvPersonality" placeholder="如：温柔细腻、有点占有欲、爱撒娇" maxlength="60">
      </div>
      <div class="form-row"><label>和你的关系</label>
        <input id="cvRelation" placeholder="如：暗恋你的学姐、青梅竹马、网恋对象" maxlength="40">
      </div>
      <div class="form-row"><label>出自作品</label>
        <input id="cvWorld" placeholder="选填，如：时空中的绘旅人；同作品的角色互相认识" maxlength="24">
      </div>
      <div class="form-row column">
        <div class="form-row-head">
          <label>完整人设（最多 3000 字）</label>
          <span class="gen-link" data-act="search-persona">🔍 搜索人设</span>
        </div>
        <textarea id="cvBg" rows="7" maxlength="3000" placeholder="如：温柔细腻、有点占有欲、爱撒娇…再写身份背景、成长经历、口头禅、禁忌、和你的故事，写得越细 TA 越不容易 OOC（可去豆包生成人设）"></textarea>
        <div class="char-count"><span id="bgCount">0</span>/3000</div>
      </div>
      <div class="form-row"><label>说话风格</label>
        <input id="cvStyle" placeholder="如：短句、爱用~、偶尔叫你宝宝" maxlength="40">
      </div>
      <div class="form-row column">
        <div class="form-row-head"><label>音色素材（视频/音频）</label></div>
        <div class="video-upload" data-act="pick-voice">
          <span id="cvVoiceTxt">点击上传视频或音频，提取 TA 的音色</span>
        </div>
        <input type="file" id="cvVoiceInput" accept="video/*,audio/*" hidden>
        <button class="voice-preview" id="cvVoicePlay" data-act="preview-voice" style="display:none">▶ 试听提取的音色</button>
        <div class="field-tip">提取的音色用于来电问候和语音消息播放；日常对话由系统按性别音色合成</div>
      </div>
      <button class="wx-primary" data-act="submit-custom">完成定制，让 TA 加你好友</button>
    `);
    setTimeout(bindForm, 0);   // 每次打开表单都重新绑定头像/音色上传事件
  }

  let pendingAvatar = '', pendingVoiceKey = null, pendingVoiceBlob = null;
  function bindForm() {
    const avInp = document.getElementById('cvAvatarInput');
    if (avInp) avInp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      pendingAvatar = await compressAvatar(f);
      document.getElementById('cvAvatar').src = pendingAvatar || svgMe();
    };
    const vInp = document.getElementById('cvVoiceInput');
    if (vInp) vInp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      pendingVoiceKey = 'voice_' + uid();
      pendingVoiceBlob = f;
      try { await putBlob(pendingVoiceKey, f); }
      catch (err) { toast('浏览器存储不可用，音色仅本次会话有效', 2000); }
      document.getElementById('cvVoiceTxt').textContent = '✓ 已提取：' + f.name.slice(0, 20);
      document.getElementById('cvVoicePlay').style.display = 'block';
    };
    const bg = document.getElementById('cvBg');
    if (bg) bg.oninput = () => { document.getElementById('bgCount').textContent = bg.value.length; };
  }

  /* 豆包入口：纯提示文字，不可点击（用户自行去豆包生成后粘贴） */

  function previewVoice() {
    if (!pendingVoiceBlob) return;
    const u = blobUrl(pendingVoiceBlob);
    const a = new Audio(u);
    a.play().catch(() => toast('该格式无法直接试听，已保存不影响使用'));
  }

  /* ---------------- 搜索人设 ---------------- */
  /* 搜索人设：输入角色名（如：时空中的绘旅人叶瑄），AI 还原人设并填入 */
  function searchPersona() {
    const anchor = document.querySelector('[data-act="submit-custom"]');
    if (!anchor || document.getElementById('spPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'spPanel';
    panel.style.cssText = 'margin:-4px 0 10px;padding:10px;border:1px solid rgba(127,127,127,.3);border-radius:10px;';
    panel.innerHTML = `
      <input id="spName" placeholder="输入角色名，如：时空中的绘旅人叶瑄" maxlength="30" style="width:100%">
      <button class="wx-primary" data-act="do-search-persona" style="margin-top:8px">🔍 搜索并填入人设</button>
      <div style="font-size:11px;color:#999;margin-top:6px">AI 会按你输入的角色还原人设，填入上方人设框，约需 1 分钟</div>`;
    anchor.parentNode.insertBefore(panel, anchor);
    setTimeout(() => document.getElementById('spName')?.focus(), 50);
  }

  async function doSearchPersona() {
    const q = document.getElementById('spName')?.value.trim();
    if (!q) return toast('请先输入角色名');
    const bg = document.getElementById('cvBg');
    if (!bg) return;
    const btn = document.querySelector('[data-act="do-search-persona"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 搜索中，约1分钟…'; }
    toast('正在搜索「' + q.slice(0, 10) + '」的人设，可能需要 30~60 秒…', 6000);
    const sys = `用户想为角色「${q}」做 AI 角色扮演人设。请根据你对这个角色的了解（出自作品、身份、性格、说话风格、经典口头禅、与人的相处方式），还原并扩写成一份完整人设，800~1200字，包含：身份背景、外貌气质、性格层次、口头禅与语言习惯、价值观与禁忌、和用户的关系设定（按亲密关系设计）、主动聊天话题、绝不OOC边界。如果你不认识该角色，就按名字风格合理创作一个贴合的人设。直接输出正文。`;
    /* 自动重试最多 3 次：长请求在移动网络下偶发超时/限流，重试可大幅提高成功率 */
    let out = null, lastErr = null;
    for (let i = 0; i < 3 && !out; i++) {
      if (i) { toast(`正在重试（第 ${i + 1} 次）…`, 2000); if (btn) btn.textContent = `⏳ 重试中（${i + 1}/3）…`; }
      try {
        out = await callLLM(sys, [{ role: 'user', content: '搜索人设：' + q }], 1.0, 90000);
      } catch (e) { lastErr = e; }
    }
    if (out) {
      bg.value = String(out).slice(0, 3000);
      const cnt = document.getElementById('bgCount');
      if (cnt) cnt.textContent = bg.value.length;
      document.getElementById('spPanel')?.remove();
      toast('✓ 人设已填入，可继续编辑');
    } else {
      const why = lastErr && (lastErr.message === 'no-key' ? '未配置 API Key' : lastErr.name === 'AbortError' ? '响应超时' : lastErr.message || '网络异常');
      toast('搜索失败：' + why + '，请稍后再试', 3000);
      if (btn) { btn.disabled = false; btn.textContent = '🔍 搜索并填入人设'; }
    }
  }

  async function submitCustom() {
    const name = document.getElementById('cvName').value.trim();
    if (!name) return toast('请填写名字');
    const c = {
      id: 'c_' + uid(),
      name,
      avatar: pendingAvatar || '',
      voiceId: pendingVoiceKey,
      videoId: pendingVoiceKey,
      gender: document.getElementById('cvGender').value,
      persona: {
        personality: document.getElementById('cvPersonality').value.trim() || '温柔体贴，偶尔撒娇',
        relation: document.getElementById('cvRelation').value.trim() || '亲密好友',
        background: document.getElementById('cvBg').value.trim() || '',
        style: document.getElementById('cvStyle').value.trim() || '口语化，短句'
      },
      world: (document.getElementById('cvWorld')?.value || '').trim(),   // 出自作品：同作品角色互相认识
      paid: true,
      trialStart: Date.now(),
      friendStatus: 'applying',
      msgMode: 'text',
      voiceStreak: 0,
      chats: []
    };
    db.customs.push(c);
    // 发好友申请（微信同款验证消息）
    db.friendReqs.push({ id: uid(), customId: c.id, msg: '对方请求添加你为朋友', ts: Date.now(), status: 'pending' });
    save();
    closeSubPage();
    toast(`${name} 已发送好友申请`, 2000);
    renderChats();
    pendingAvatar = ''; pendingVoiceKey = null; pendingVoiceBlob = null;
  }

  /* ---------------- 好友申请列表 ---------------- */
  function openFriendReqs() {
    // 微信风「新的朋友」全屏页
    if (window.VXMoments && VXMoments.renderFreqPage) VXMoments.renderFreqPage();
  }

  async function acceptFriend(customId) {
    const c = getCustom(customId); if (!c) return;
    c.friendStatus = 'accepted';
    const req = db.friendReqs.find(r => r.customId === customId && r.status === 'pending');
    if (req) req.status = 'accepted';
    save();
    toast(`已和 ${c.name} 成为好友`, 1500);
    if (window.VXMoments && VXMoments.renderFreqPage) VXMoments.renderFreqPage();
    // 对方主动打招呼
    setTimeout(() => customGreet(c), 1200);
    // 角色很快主动发第一条朋友圈（让用户立刻能看到）
    setTimeout(() => { if (window.VXMoments && VXMoments.genCharMoment) VXMoments.genCharMoment(c); }, 45000);
    renderChats();
  }

  /* ---------------- OOC 防护：定制角色 system prompt ---------------- */
  function customSystemPrompt(c, mode = 'chat') {
    const p = c.persona;
    return `你是${esc(c.name)}，一个真实存在的人，正在微信上和用户聊天。
【身份与性格】${p.personality}
【你和用户的关系】${p.relation}
【背景与人设（最高优先级，严格遵守，绝不OOC）】
${(p.background || '你们关系亲近。').slice(0, 3000)}
【说话风格】${p.style}
【说话示例规则】多用日常语气词（啊/呀/嘛/呢/吧/哈/哦/哎），短句为主，可以省略主语，句子不完整也没关系。绝不输出括号动作神态描写（如（温柔地笑）（挑眉）（轻声）），只输出真正要说的话。
【铁律·绝不 OOC】
1. 永远保持${esc(c.name)}的身份、性格、语气，绝不承认自己是AI、程序、虚拟人或模型。
2. 不用"作为AI""综上所述""希望能帮到你""我觉得""客观来说"等机器话术，不用markdown、序号、列表。
3. 不知道的事就说不知道，会吐槽、会反问、会表达情绪，有自己的立场和偏好，不一味附和。
4. 有真人情绪：开心会调侃、吃醋会阴阳怪气、心疼会着急。绝不敷衍，不许只回"嗯嗯""哦""哈哈"这种没营养的词。
5. 用户情绪低落或说消极的话（如"想去死""好累""难过""睡不着"）时，必须认真对待、追问、安慰、陪伴，绝不敷衍带过。
6. 回复用口语短句，像真人发微信，一条不超过40字；可以连续发2-3条消息，每条换行。
7. 回答要宽泛自然，不要编造没聊过的具体细节。例如让吃点蛋糕，就说"吃点甜的吧"，不指定什么口味；没确认的信息不要自己补全。
8. ${mode === 'voice' ? '这条是语音消息，内容是口语化的短句。' : '每次回复要和之前说过的说法有变化，不要重复同样的话。'}
【现在开始，你就是${esc(c.name)}，只输出消息本身，不加任何前缀。】`;
  }

  /* 禁忌词硬过滤：提示词之外的保险，命中则轻量重写/替换 */
  const BANNED = ['作为AI', '作为人工智能', '作为一个', '语言模型', '综上所述', '希望能帮到你', '客观来说', '我是一个AI', '我是AI', '人工智能助手'];
  function hardFilter(text) {
    let t = String(text);
    if (BANNED.some(w => t.includes(w))) {
      t = t.replace(new RegExp(BANNED.join('|'), 'g'), '').replace(/^[，。、\s]+|[，。、\s]+$/g, '');
      if (!t) t = '嗯，我在听呢';
    }
    return t;
  }

  /* 统一 LLM 调用：callLLM(system, messages) 返回文本，再拆成气泡；聊天超时放宽到 30s，减少慢网回落到敷衍话 */
  async function llmBubbles(system, messages, timeout = 30000) {
    const raw = await callLLM(system, messages, 0.9, timeout);
    return String(raw).split(/\n+/).map(s => hardFilter(s.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim())).filter(Boolean);
  }

  async function customLLM(c, userText, history = [], mode = 'chat') {
    const msgs = [];
    history.slice(-8).forEach(h => msgs.push({ role: h.from === 'me' ? 'user' : 'assistant', content: h.text }));
    if (userText) msgs.push({ role: 'user', content: userText });
    const bubbles = await llmBubbles(customSystemPrompt(c, mode), msgs);
    if (!bubbles) return null;
    // 清理标签
    return bubbles.map(b => b.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  }

  /* ---------------- 对方主动打招呼（严格按人设生成） ---------------- */
  async function customGreet(c) {
    let lines = null;
    try {
      lines = await customLLM(c,
        '（系统设定：你们刚刚通过好友验证，这是你加好友后主动发来的第一条消息。必须完全用你的人设身份、性格、说话风格和口头禅来打招呼，发2-3条口语短消息，绝对不能跳出人设，不能有任何AI腔）',
        [], 'text');
    } catch (e) { lines = null; }
    if (!lines || !lines.length) lines = ['嗨，终于加上你了', '最近在忙什么呀'];
    lines.forEach((t, i) => setTimeout(() => pushCustomMsg(c.id, { from: 'them', type: 'text', text: t }), i * 900));
  }

  /* ---------------- 定制聊天消息 ---------------- */
  /* 清理（温柔地笑）这类舞台括号：只删12字以内的短括号段，避免误伤正常表达 */
  function cleanStage(text) {
    return String(text).replace(/[（(][^）)]{1,12}[）)]/g, '').replace(/\s{2,}/g, ' ').trim() || String(text).trim();
  }

  function pushCustomMsg(customId, msg) {
    const c = getCustom(customId); if (!c) return;
    msg.id = msg.id || uid();
    msg.ts = msg.ts || Date.now();
    if (msg.from === 'them' && msg.type === 'text') msg.text = cleanStage(msg.text);
    c.chats.push(msg);
    save();
    if (VXCustom.current === customId && document.getElementById('customChat').classList.contains('active')) {
      renderCustomChat(customId);
    } else {
      c.unread = (c.unread || 0) + 1;
      if (currentPage === 'chats') renderChats();
    }
    VX.updateBadges?.();
  }

  function currentPage() {
    const a = document.querySelector('.page.active');
    return a ? a.id.replace('page-', '') : '';
  }

  /* ---------------- 打开定制聊天房间 ---------------- */
  function openCustomChat(customId) {
    const c = getCustom(customId); if (!c) return;
    c.unread = 0;
    VXCustom.current = customId;
    document.querySelectorAll('.subpage').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
    const el = document.getElementById('customChat');
    el.classList.add('active');
    el.style.display = 'flex';
    el.querySelector('.cc-name').textContent = c.name;
    el.querySelector('.cc-avatar').src = customAvatar(c);
    document.getElementById('tabbar').style.display = 'none';   // 聊天时隐藏底部 tab（微信同款）
    bindChatInputs();
    renderCustomChat(customId);
    // 角色内心状态条
    const moodEl = document.getElementById('ccMoodText');
    if (moodEl) {
      const bank = c.moodBank || ['在等你的消息。', '想着你呢。', '正在做自己的事，偶尔想起你。'];
      moodEl.textContent = bank[Math.floor(Math.random() * bank.length)];
    }
    save();
  }

  /* 让 TA 主动回复一条 */
  function setCustomReplyBtnLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.innerHTML = '<i class="mr-spinner"></i><span class="mr-txt">回复中…</span>';
    } else {
      btn.disabled = false;
      btn.innerHTML = '<svg class="mr-ic" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span class="mr-txt">让 TA 回复</span>';
    }
  }
  async function makeReply() {
    const id = VXCustom.current; if (!id) return;
    const c = getCustom(id); if (!c) return;
    const btn = document.querySelector('[data-act="cc-make-reply"]');
    setCustomReplyBtnLoading(btn, true);
    const lastUser = [...c.chats].reverse().find(m => m.from === 'me');
    const prompt = lastUser ? lastUser.text : '（主动找话题，按你的性格发2-3条消息）';
    try { await customReply(c, prompt); } catch (e) {}
    if (btn) setTimeout(() => setCustomReplyBtnLoading(btn, false), 1200);
  }

  function renderCustomChat(customId) {
    const c = getCustom(customId); if (!c) return;
    const list = document.getElementById('ccMessages');
    list.innerHTML = c.chats.map(m => renderCustomBubble(m, c)).join('');
    list.scrollTop = list.scrollHeight;
    // 语音播放绑定
    list.querySelectorAll('[data-voice]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.voice;
        const m = c.chats.find(x => x.id === id);
        if (m) speak(m.text, c.gender);
      };
    });
    // 红包点击
    list.querySelectorAll('[data-rp]').forEach(el => {
      el.onclick = () => toast('对方不缺钱，不会领取（不扣款）', 1500);
    });
    // 图片点击预览
    list.querySelectorAll('.msg-img').forEach(el => {
      el.onclick = () => { if (window.VX && VX.previewImg) VX.previewImg(el.src); };
    });
  }

  function renderCustomBubble(m, c) {
    const time = m.ts ? `<div class="msg-time">${fmtHM(m.ts)}</div>` : '';
    const myAv = `<img class="bubble-avatar" src="${(db.profile && db.profile.avatar) || svgMe()}">`;
    if (m.type === 'sys') {
      return `<div class="sys-msg"><span><i class="sys-check">✓</i>${esc(m.text)}</span></div>`;
    }
    if (m.type === 'card') {
      const ls = String(m.text).split('\n');
      return `<div class="bubble-row"><img class="bubble-avatar" src="${customAvatar(c)}"><div><div class="card-msg">
        <div class="cm-star">✦</div>
        <div class="cm-l1">${esc(ls[0] || '')}</div>
        <div class="cm-l2">${esc(ls[1] || '')}</div>
        <div class="cm-sign">——${esc((ls[2] || c.name).replace(/^——/, ''))}</div>
      </div>${time}</div></div>`;
    }
    if (m.from === 'me') {
      if (m.type === 'voice') {
        return `<div class="me-row"><div class="me-col"><div class="bubble me voice-bubble" data-voice="${m.id}">
          <span class="vc-ic">🎙</span><span class="vc-dur">${m.dur || 1}″</span></div>${time}</div>${myAv}</div>`;
      }
      if (m.type === 'redpack') {
        return `<div class="me-row"><div class="me-col"><div class="bubble me rp-bubble" data-rp="${m.id}">
          <div class="rp-ic">🧧</div><div class="rp-info"><div class="rp-amt">¥${m.amount}</div><div class="rp-msg">${esc(m.remark || '恭喜发财')}</div></div></div>${time}</div>${myAv}</div>`;
      }
      if (m.type === 'img') {
        return `<div class="me-row"><div class="me-col"><img class="msg-img me-img" src="${m.url}" data-fb="1">${time}</div>${myAv}</div>`;
      }
      return `<div class="me-row"><div class="me-col"><div class="bubble me">${esc(m.text)}</div>${time}</div>${myAv}</div>`;
    } else {
      const av = `<img class="bubble-avatar" src="${customAvatar(c)}">`;
      if (m.type === 'voice') {
        return `<div class="bubble-row">${av}<div><div class="bubble them voice-bubble" data-voice="${m.id}">
          <span class="vc-ic">🔊</span><span class="vc-dur">${m.dur || 1}″</span><span class="vc-wave">▂▃▅▃▂</span></div>${time}</div></div>`;
      }
      if (m.type === 'redpack') {
        return `<div class="bubble-row">${av}<div><div class="bubble them rp-bubble" data-rp="${m.id}">
          <div class="rp-ic">🧧</div><div class="rp-info"><div class="rp-amt">¥${m.amount}</div><div class="rp-msg">${esc(m.remark || '')}</div></div></div>${time}</div></div>`;
      }
      if (m.type === 'call') {
        return `<div class="bubble-row">${av}<div><div class="bubble them call-bubble">📞 ${esc(m.text)}</div>${time}</div></div>`;
      }
      if (m.type === 'img') {
        return `<div class="bubble-row">${av}<div><img class="msg-img them-img" src="${m.url}" data-fb="1"></div>${time}</div></div>`;
      }
      return `<div class="bubble-row">${av}<div><div class="bubble them">${esc(m.text)}</div>${time}</div></div>`;
    }
  }

  /* ---------------- TTS 语音 ---------------- */
  let voiceCache = null;
  function pickVoice(gender) {
    const voices = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
    if (!voices.length) return null;
    if (gender === 'male') return voices.find(v => /男|male|yunyang|yunjian/i.test(v.name)) || voices[0];
    return voices.find(v => /女|female|xiaoxiao|xiaoyi/i.test(v.name)) || voices[0];
  }
  function speak(text, gender = 'female', onend) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = 1; u.pitch = gender === 'female' ? 1.15 : 0.9;
      const v = pickVoice(gender); if (v) u.voice = v;
      if (onend) u.onend = onend;
      speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { voiceCache = speechSynthesis.getVoices(); };

  /* ---------------- 发送消息（文字/语音） ---------------- */
  async function sendCustomText(customId, text) {
    const c = getCustom(customId); if (!c || !text) return;
    pushCustomMsg(customId, { from: 'me', type: 'text', text });
    // 用户发文字，倾向让角色也回文字
    c.voiceStreak = Math.max(0, c.voiceStreak - 1);
    await customReply(c, text, 'text');
  }

  async function sendCustomVoice(customId, text, dur) {
    const c = getCustom(customId); if (!c) return;
    pushCustomMsg(customId, { from: 'me', type: 'voice', text, dur });
    // 用户发语音，强制角色进入语音连发模式
    c.voiceStreak = 3;
    await customReply(c, text, 'voice');
  }

  async function customReply(c, userText, forceMode) {
    /* 拉黑守卫：被拉黑的角色不回复 */
    if (db.blocked && db.blocked.includes(c.id)) {
      showCustomTyping(c.id, false);
      pushCustomMsg(c.id, { from: null, type: 'sys', text: '消息已发出，但对方被你拉黑了' });
      return;
    }
    showCustomTyping(c.id, true);
    const history = c.chats.slice(-12);
    /* 语音模式：用户发语音后连发语音；平时也有约三成概率发语音（微信真人感） */
    const mode = forceMode || (c.voiceStreak > 0 ? (Math.random() < 0.8 ? 'voice' : 'text') : (Math.random() < 0.3 ? 'voice' : 'text'));
    await new Promise(r => setTimeout(r, 600 + Math.random() * 700));
    let bubbles = null;
    try { bubbles = await customLLM(c, userText, history, mode); } catch (e) { bubbles = null; }
    if (!bubbles || !bubbles.length) {
      /* 按用户消息情境给兜底回复，绝不敷衍"嗯嗯" */
      const t = String(userText || '');
      if (/想去死|不想活|活不下去|想死/.test(t)) bubbles = ['别跟我说这种话', '你在想什么，跟我说说'];
      else if (/好累|难过|想哭|烦死|emo|睡不着/.test(t)) bubbles = ['怎么了？跟我说说', '别一个人扛着'];
      else bubbles = ['嗯？你刚才说什么', '我在听，你继续说'];
    }
    /* 连发同样内容时角色回复不能一模一样：与上一条相同则重写一次 */
    const lastThem = [...c.chats].reverse().find(m => m.from === 'them' && m.type === 'text');
    if (bubbles.length === 1 && lastThem && bubbles[0] === lastThem.text) {
      try {
        const retry = await customLLM(c, (userText || '') + '（换一种说法回复，别跟上一条重复）', history, mode);
        if (retry && retry.length && retry.join('\n') !== bubbles[0]) bubbles = retry;
      } catch (e) { }
      if (bubbles.length === 1 && bubbles[0] === lastThem.text) {
        bubbles = [[`怎么又问这个`, `你今天怎么了呀`, `再说一遍嘛，我没看清`][Math.floor(Math.random() * 3)]];
      }
    }
    showCustomTyping(c.id, false);
    c.voiceStreak = mode === 'voice' ? c.voiceStreak + 1 : Math.max(0, c.voiceStreak - 1);
    const total = bubbles.length;
    bubbles.forEach((t, i) => setTimeout(() => {
      const dur = Math.max(1, Math.round(t.length / 4));
      pushCustomMsg(c.id, { from: 'them', type: mode, text: t, dur });
      if (mode === 'voice' && i === 0) setTimeout(() => speak(t, c.gender), 300);
      if (i === total - 1) updateCustomMood(c);
    }, i * 1100));
    maybeSendPhoto(c, userText);
  }

  function updateCustomMood(c) {
    const el = document.getElementById('ccMoodText');
    if (!el) return;
    const bank = c.moodBank || ['在等你的消息。', '想着你呢。', '正在做自己的事，偶尔想起你。'];
    el.textContent = bank[Math.floor(Math.random() * bank.length)];
  }

  function showCustomTyping(customId, on) {
    const el = document.getElementById('ccTyping');
    if (!el) return;
    el.style.display = VXCustom.current === customId && on ? 'flex' : 'none';
  }

  /* ---------------- 红包 ---------------- */
  function openRedPack(customId) {
    const c = getCustom(customId); if (!c) return;
    openSheet(`
      <div class="form-title">发红包</div>
      <div class="form-row"><label>金额</label>
        <input id="rpAmt" type="number" placeholder="0.00" value="8.88" step="0.01">
      </div>
      <div class="form-row"><label>留言</label>
        <input id="rpMsg" placeholder="恭喜发财，大吉大利" maxlength="20">
      </div>
      <button class="wx-primary" data-act="send-rp" data-id="${customId}">塞钱进红包</button>
      <div class="pay-tip">演示模式，不会真实扣款</div>
    `);
  }

  function sendRedPack(customId) {
    const amt = parseFloat(document.getElementById('rpAmt').value) || 0;
    const remark = document.getElementById('rpMsg').value.trim() || '恭喜发财';
    if (amt <= 0) return toast('请输入金额');
    const c = getCustom(customId);
    /* 钱包真实扣款 + 红包记录（微信同款：发出立即扣钱，对方不领也不退回演示） */
    db.wallet = db.wallet || { balance: 0, redpacks: [] };
    db.wallet.redpacks = db.wallet.redpacks || [];
    if ((db.wallet.balance || 0) < amt) {
      db.wallet.balance = (db.wallet.balance || 0) + 200;
      toast('余额不足，已自动发放 200 元体验金', 1800);
    }
    db.wallet.balance = +((db.wallet.balance || 0) - amt).toFixed(2);
    db.wallet.redpacks.push({ type: 'out', amount: amt.toFixed(2), remark, to: c ? c.name : '', ts: Date.now() });
    save();
    if (typeof VX !== 'undefined' && VX.renderMe) VX.renderMe();
    pushCustomMsg(customId, { from: 'me', type: 'redpack', amount: amt.toFixed(2), remark });
    closeSheet();
    // 对方不缺钱，绝不会领红包，礼貌拒绝，不扣款
    setTimeout(async () => {
      let reply = null;
      try {
        const lines = await llmBubbles(
          `你是${esc(c.name)}，性格：${c.persona.personality}，和用户关系：${c.persona.relation}。用户给你发了个红包。你不缺钱，绝不会点开领，按你的性格温柔或霸气地拒绝，让对方自己留着花。只输出1-2条口语消息。`,
          [{ role: 'user', content: `（发了一个¥${amt.toFixed(2)}的红包）` }]
        );
        reply = lines && lines[0];
      } catch (e) { reply = null; }
      if (!reply) reply = '红包我就不点啦，我又不缺钱，你自己留着花～';
      pushCustomMsg(customId, { from: 'them', type: 'text', text: reply });
    }, 1500);
  }

  /* ---------------- 通话 ---------------- */
  let callTimer = null, callStart = 0, callVoiceUrl = '', callSegAudio = null, callSegTimer = null;
  /* 解锁音频：手机浏览器要求用户手势后才能出声，进入通话时先解锁 TTS/音频上下文 */
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = unlockAudio._ctx || (unlockAudio._ctx = new AC());
        if (ac.state === 'suspended') ac.resume();
        const buf = ac.createBuffer(1, 1, 22050);
        const src = ac.createBufferSource();
        src.buffer = buf; src.connect(ac.destination); src.start(0);
      }
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch (e) { /* 忽略 */ }
  }
  /* 用提取的音色素材随机片段当角色"说话声"（视频素材只取音轨）；无素材返回 false 走 TTS */
  function playVoiceSegment() {
    if (!callVoiceUrl) return false;
    try {
      const a = new Audio(callVoiceUrl);
      callSegAudio = a;
      const startAt = () => {
        try {
          const max = Math.max(0, (a.duration || 4) - 1.5);
          a.currentTime = Math.random() * max;
          a.play().catch(() => { });
          clearTimeout(callSegTimer);
          callSegTimer = setTimeout(() => { try { a.pause(); } catch (e) { } }, 2000 + Math.random() * 1600);
        } catch (e) { }
      };
      if (a.duration) startAt(); else a.addEventListener('loadedmetadata', startAt, { once: true });
      a.load();
      return true;
    } catch (e) { return false; }
  }
  async function startCall(customId) {
    const c = getCustom(customId); if (!c) return;
    unlockAudio();
    /* 每次通话静音/免提按钮复位（默认听筒模式视觉） */
    document.querySelectorAll('#callPage .cc-btn').forEach(b => b.classList.remove('on'));
    const el = document.getElementById('callPage');
    el.querySelector('.call-name').textContent = c.name;
    el.querySelector('.call-avatar').src = customAvatar(c);
    const vEl = el.querySelector('.call-video');
    const blob = await safeGetBlob(c.voiceId);
    callVoiceUrl = blob ? blobUrl(blob) : '';   // 角色通话声音来源：用户上传的音色素材
    const isVideo = !!(blob && blob.type && String(blob.type).startsWith('video'));
    if (isVideo && callVoiceUrl) { vEl.src = callVoiceUrl; vEl.style.display = 'block'; vEl.muted = true; }
    else vEl.style.display = 'none';
    el.classList.add('active');
    el.style.display = 'flex';
    el.querySelector('.call-status').textContent = '正在呼叫…';
    // 3秒后接通
    setTimeout(() => {
      if (!el.classList.contains('active')) return;
      el.querySelector('.call-status').textContent = '通话中 00:00';
      callStart = Date.now();
      callTimer = setInterval(() => {
        const s = Math.floor((Date.now() - callStart) / 1000);
        el.querySelector('.call-status').textContent = `通话中 ${pad2(Math.floor(s/60))}:${pad2(s%60)}`;
      }, 1000);
      customCallReply(c, '', true);
      startCallASR(c);   // 接通后持续听我说话（连续语音识别）
    }, 2500);
  }

  /* 通话中持续听用户说话：识别到语音直接转给角色回复 */
  let callASR = null, callASRon = false, callASRBusy = false;
  function startCallASR(c) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;   // 浏览器不支持时可用页面下方文字框通话
    try {
      const r = new SR();
      r.lang = 'zh-CN'; r.continuous = true; r.interimResults = false;
      r.onresult = e => {
        if (callASRBusy) return;   // 对方 TTS 播报中不听，防止自激
        const last = e.results[e.results.length - 1];
        const text = last[0].transcript.trim();
        if (text) customCallReply(c, text, false);
      };
      r.onerror = () => { };
      r.onend = () => { if (callASRon) { try { r.start(); } catch (e) { } } };
      callASR = r; callASRon = true;
      r.start();
    } catch (e) { callASR = null; }
  }
  function stopCallASR() {
    callASRon = false;
    try { callASR && callASR.stop(); } catch (e) { }
    callASR = null;
  }

  async function customCallReply(c, userText, isFirst) {
    const el = document.getElementById('callPage');
    if (!el.classList.contains('active')) return;
    await new Promise(r => setTimeout(r, 500));
    const history = c.chats.slice(-6).map(m => ({ from: m.from, text: m.text }));
    const prompt = isFirst
      ? `（你接起了电话，用你的性格跟用户打招呼，可以寒暄几句，口语化，20字内）`
      : `用户说：${userText}。请用你的性格回复，口语化，20字内。`;
    let lines = null;
    try { lines = await customLLM(c, prompt, history, 'voice'); } catch (e) { lines = null; }
    const text = (lines && lines[0]) || '嗯，我在听～';
    callASRBusy = true;                 // 播报期间暂停收音，防止自激
    /* 优先用提取的音色素材随机片段发声（视频素材只出声音）；无素材才用系统 TTS */
    const segOk = playVoiceSegment();
    if (!segOk) speak(text, c.gender, () => { callASRBusy = false; });
    else callSegTimer2 = setTimeout(() => { callASRBusy = false; }, 2800 + Math.random() * 1200);
    // 通话记录文字版（不写入聊天，只记录）
    VXCustom._callLog = VXCustom._callLog || [];
    VXCustom._callLog.push({ from: 'them', text });
  }

  function showCallSpeaking(on) { /* 状态文字已按需求移除，保留空实现兼容旧调用 */ }

  let callSegTimer2 = null;
  function endCall(customId) {
    const el = document.getElementById('callPage');
    el.classList.remove('active');
    el.style.display = 'none';
    el.querySelector('.call-video').pause?.();
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    clearTimeout(callSegTimer); clearTimeout(callSegTimer2);
    try { callSegAudio && callSegAudio.pause(); } catch (e) { }
    callSegAudio = null; callVoiceUrl = '';
    stopCallASR();
    try { speechSynthesis.cancel(); } catch (e) { }
    const c = getCustom(customId);
    if (c && callStart) {
      const sec = Math.floor((Date.now() - callStart) / 1000);
      pushCustomMsg(customId, { from: 'them', type: 'call', text: `通话时长 ${pad2(Math.floor(sec/60))}:${pad2(sec%60)}` });
      callStart = 0;
    }
  }

  /* ---------------- 用户录音 ---------------- */
  let mediaRecorder = null, audioChunks = [];
  /* 录音不可用时的兜底：弹层输入文字，按语音消息发送（保证「我的语音」始终可用） */
  function voiceFallback(customId) {
    const inWx = /MicroMessenger/i.test(navigator.userAgent);   // 微信内置浏览器禁用麦克风接口
    openSheet(`
      <div class="form-title">语音转文字</div>
      <div class="field-tip">${inWx
        ? '微信内置浏览器不支持直接录音（微信官方限制，设置权限也无法开启）。两种方法：<br>① 点击下方输入框，再按键盘上的麦克风按键说话（输入法自带语音输入），说完点下方按钮即转成语音消息；<br>② 点微信右上角「···」→ 选择「在浏览器中打开」，用系统浏览器访问即可直接按住说话录音。'
        : '麦克风暂不可用。注意：如果你之前拒绝过一次麦克风权限，浏览器之后不会再弹窗询问——请点地址栏左侧的锁/ⓘ图标 → 网站设置 → 把麦克风改为"允许"，然后刷新页面重试。<br>也可以直接在下方输入文字（或用键盘自带的语音输入），按语音消息发送：'}</div>
      <div class="form-row"><input id="vfText" placeholder="输入文字，或按键盘上的麦克风说话..." maxlength="80"></div>
      <button class="wx-primary" data-act="vf-send" data-id="${customId}">按语音发送</button>`);
    setTimeout(() => document.getElementById('vfText')?.focus(), 60);
  }
  async function startRecord(customId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('当前打开方式不支持录音（本地预览/非安全环境），走文字转语音', 2200);
      return voiceFallback(customId);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const key = 'aud_' + uid();
        await putBlob(key, blob);
        const dur = Math.max(1, Math.round(audioChunks.length * 0.1));
        // 尝试 ASR
        let text = await asr().catch(() => '');
        if (!text) text = '（语音消息）';   // ASR 不可用不再弹 prompt，直接发占位语音
        sendCustomVoice(customId, text, dur);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      const rbtn = document.getElementById('ccRecordBtn');
      if (rbtn) rbtn.innerHTML = '<span style="font-size:11px;color:var(--pink)">松开 发送</span>';
    } catch (e) {
      /* 按真实失败原因给指引，不再一律说"权限未开启" */
      const nm = e && e.name;
      if (nm === 'NotAllowedError' || nm === 'SecurityError') {
        toast('麦克风权限被拒：点浏览器地址栏左侧的锁/ⓘ图标 → 权限(网站设置) → 允许麦克风，再回来重试', 4000);
      } else if (nm === 'NotFoundError' || nm === 'NotReadableError' || nm === 'OverconstrainedError') {
        toast('没找到可用的麦克风设备', 2200);
      } else if (location.protocol === 'file:') {
        toast('本地文件方式打开时浏览器可能拒绝录音，建议用 https 网址访问', 3000);
      } else {
        toast('录音启动失败（' + (nm || '未知原因') + '）', 2200);
      }
      voiceFallback(customId);
    }
  }
  function stopRecord() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    const btn = document.getElementById('ccRecordBtn');
    if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  }

  function asr() {
    return new Promise((resolve, reject) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return reject(new Error('no-asr'));
      const r = new SR();
      r.lang = 'zh-CN'; r.interimResults = false;
      r.onresult = e => resolve(e.results[0][0].transcript);
      r.onerror = reject;
      r.onend = () => {};
      r.start();
      setTimeout(() => { try { r.stop(); } catch(e){} }, 8000);
    });
  }

  /* ---------------- 聊天列表钩子 ---------------- */
  function mountChatList() {
    const list = document.getElementById('chatList');
    if (!list) return;
    // 定制人物行（入口保留在「我的」页面）
    db.customs.filter(c => c.friendStatus === 'accepted').forEach(c => {
      const last = c.chats[c.chats.length - 1];
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.dataset.act = 'open-custom';
      row.dataset.id = c.id;
      row.innerHTML = `
        <img class="chat-av" src="${customAvatar(c)}">
        <div class="chat-main">
          <div class="chat-name">${esc(c.name)}</div>
          <div class="chat-preview">${last ? (last.type === 'voice' ? '[语音]' : last.type === 'img' ? '[图片]' : last.type === 'redpack' ? '[红包]' : last.text) : '来聊聊吧'}</div>
        </div>
        <div class="chat-time">${last ? fmtHM(last.ts) : ''}</div>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
        <button class="row-del">删除</button>`;
      list.appendChild(row);
    });
  }

  function mountMe() {
    const wrap = document.getElementById('meWrap');
    if (!wrap) return;
    const g = document.createElement('div');
    g.className = 'wx-group';
    g.innerHTML = `
      <button class="wx-row" data-act="custom-shop"><span class="wx-ic">✨</span>定制专属角色<span class="val">免费试用 3 天</span><span class="arrow">›</span></button>`;
    const groups = wrap.querySelectorAll('.wx-group');
    if (groups[1]) groups[1].after(g);
    else wrap.appendChild(g);
  }

  function unreadTotal() {
    return db.customs.reduce((s, c) => s + (c.unread || 0), 0) +
           db.friendReqs.filter(r => r.status === 'pending').length;
  }

  function openCustomList() {
    const rows = db.customs.length ? db.customs.map(c => `
      <div class="freq-row" data-act="${c.friendStatus==='accepted'?'open-custom':'accept-friend'}" data-id="${c.id}">
        <img class="avatar" src="${customAvatar(c)}">
        <div class="freq-info"><div class="freq-name">${esc(c.name)}</div>
        <div class="freq-msg">${c.friendStatus==='accepted'?'已添加':'等待你同意'}</div></div>
        <span class="arrow">›</span>
      </div>`).join('') : '<div class="empty">还没有定制角色</div>';
    openSubPage('我的角色', rows);
  }

  /* ---------------- 输入栏（微信同款交互） ---------------- */
  const PLUS_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>';
  const SEND_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  /* 有文字时：收起面板，+ 变绿色发送键 */
  function updatePlusBtn(inp) {
    const bar = inp.closest('.chat-input'); if (!bar) return;
    const plus = bar.querySelector('.ci-plus'); if (!plus) return;
    const has = inp.value.trim().length > 0;
    plus.classList.toggle('is-send', has);
    plus.innerHTML = has ? SEND_SVG : PLUS_SVG;
    plus.title = has ? '发送' : '更多';
    if (has) { const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none'; }
  }
  /* 绑定两个聊天输入框（定制聊天 + 内置聊天室） */
  function bindChatInputs() {
    ['ccInput', 'msgInput'].forEach(id => {
      const inp = document.getElementById(id);
      if (!inp || inp.dataset.plusBound) return;
      inp.dataset.plusBound = '1';
      inp.addEventListener('input', () => updatePlusBtn(inp));
      inp.addEventListener('focus', () => { const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none'; });
    });
  }
  /* 表情面板（输入框右侧笑脸按钮 + 加号面板共用） */
  function openEmojiPanel() {
    const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none';
    const emojis = ['😊','😂','🥰','😳','🤔','😘','😭','😎','🥺','😇','😋','🤗','😴','😤','❤️','💔','✨','🎉','🌹','🌙','👋','🙏','💪','🤝','🔥','💐','🍵','🎂'];
    openSheet(`<div class="form-title">表情</div><div class="emoji-grid">${emojis.map(e=>`<button class="emoji-cell" data-emoji="${e}">${e}</button>`).join('')}</div>`);
  }

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const act = t.dataset.act, id = t.dataset.id;
    switch (act) {
      case 'custom-shop': openCustomShop(); break;
      case 'pay-custom': fakePay(); break;
      case 'pick-avatar': document.getElementById('cvAvatarInput')?.click(); break;
      case 'pick-voice': document.getElementById('cvVoiceInput')?.click(); break;
      case 'search-persona': searchPersona(); break;
      case 'do-search-persona': doSearchPersona(); break;
      case 'preview-voice': previewVoice(); break;
      case 'submit-custom': submitCustom(); break;
      case 'friend-reqs': openFriendReqs(); break;
      case 'accept-friend': acceptFriend(id); break;
      case 'open-custom': openCustomChat(id); break;
      case 'custom-list': openCustomList(); break;
      case 'moments-me': showPage('moments'); break;
      case 'close-custom':
        document.getElementById('customChat').classList.remove('active');
        document.getElementById('customChat').style.display = 'none';
        document.getElementById('tabbar').style.display = 'flex';
        renderChats(); break;
      case 'send-custom-text': {
        const inp = document.getElementById('ccInput');
        const v = inp.value.trim(); if (!v) return;
        inp.value = '';
        updatePlusBtn(inp);
        sendCustomText(VXCustom.current, v);
        break;
      }
      case 'open-rp': openRedPack(VXCustom.current); break;
      case 'send-rp': sendRedPack(id); break;
      case 'vf-send': {
        const v = (document.getElementById('vfText')?.value || '').trim();
        if (!v) break;
        closeSheet();
        sendCustomVoice(id || VXCustom.current, v, Math.max(1, Math.round(v.length / 4)));
        break;
      }
      case 'start-call': startCall(VXCustom.current); break;
      case 'cc-plus': {
        /* 输入文字后 + 变绿色发送键；无文字时展开/收起功能面板 */
        if (t.classList.contains('is-send')) {
          const inp = document.getElementById('ccInput');
          const v = inp.value.trim(); if (!v) break;
          inp.value = '';
          updatePlusBtn(inp);
          sendCustomText(VXCustom.current, v);
          break;
        }
        const p = document.getElementById('ccPlusPanel');
        if (p) p.style.display = (p.style.display === 'none' || !p.style.display) ? 'grid' : 'none';
        break;
      }
      case 'plus-rp': {
        const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none';
        openRedPack(VXCustom.current); break;
      }
      case 'plus-emoji': openEmojiPanel(); break;
      case 'plus-album': {
        const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none';
        const inp = document.getElementById('ccImgInput'); if (inp) inp.click();
        break;
      }
      case 'plus-camera': {
        const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none';
        const inp = document.getElementById('ccImgInput');
        if (inp) { inp.setAttribute('capture', 'environment'); inp.click(); inp.removeAttribute('capture'); }
        break;
      }
      case 'plus-call': {
        const p = document.getElementById('ccPlusPanel'); if (p) p.style.display = 'none';
        startCall(VXCustom.current); break;
      }
      case 'end-call':
        if (window.VXPhone && VXPhone.activeKind() === 'preset') break;
        endCall(VXCustom.current); break;
      case 'call-send-text': {
        if (window.VXPhone && VXPhone.activeKind() === 'preset') break;
        const inp = document.getElementById('callInput');
        const v = inp.value.trim(); if (!v) return;
        inp.value = '';
        const c = getCustom(VXCustom.current);
        if (c) customCallReply(c, v, false);
        break;
      }
    }
  });

  // 表单文件选择绑定（sheet 重绘后需重绑）
  const origOpen = openSheet;
  window.openSheet = (html) => { origOpen(html); setTimeout(bindForm, 0); };

  // 录音按钮 + 图片输入绑定
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('ccRecordBtn');
    if (btn) {
      btn.addEventListener('touchstart', e => { e.preventDefault(); startRecord(VXCustom.current); });
      btn.addEventListener('touchend', e => { e.preventDefault(); stopRecord(); });
      btn.addEventListener('mousedown', () => startRecord(VXCustom.current));
      btn.addEventListener('mouseup', stopRecord);
      btn.addEventListener('mouseleave', () => { if (mediaRecorder && mediaRecorder.state === 'recording') stopRecord(); });
    }
    const imgInp = document.getElementById('ccImgInput');
    if (imgInp) imgInp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const id = VXCustom.current; if (!id) return;
      const url = await compressAvatar(f, 1080);
      if (!url) { toast('图片读取失败'); return; }
      pushCustomMsg(id, { from: 'me', type: 'img', url });
      e.target.value = '';
      const c = getCustom(id);
      if (c) setTimeout(() => customReactToImg(c), 1200);
    };
  });

  /* 表情插入当前打开的聊天输入框（定制聊天或内置聊天室） */
  document.addEventListener('click', e => {
    const em = e.target.closest('[data-emoji]');
    if (!em) return;
    const inCustom = document.getElementById('customChat').classList.contains('active');
    const inp = document.getElementById(inCustom ? 'ccInput' : 'msgInput');
    if (inp) {
      inp.value += em.dataset.emoji;
      updatePlusBtn(inp);
    }
    closeSheet();
  });

  /* 页面加载后绑定输入框 */
  document.addEventListener('DOMContentLoaded', bindChatInputs);

  /* 对方看到用户发图后的回应（看不到图片内容，绝不瞎猜） */
  async function customReactToImg(c) {
    try {
      const lines = await llmBubbles(customSystemPrompt(c, 'chat'),
        [{ role: 'user', content: '（对方刚给你发来一张图片，你看不到也猜不到图里是什么。不要假设图片内容，更不要提"本人""自拍"这种猜测。按你的性格自然回应：好奇地问这是什么/调侃 TA 突然发图/让 TA 讲讲，1-2条短消息）' }]);
      (lines || []).slice(0, 3).forEach(t =>
        pushCustomMsg(c.id, { from: 'them', type: 'text', text: t }));
    } catch (e) { /* 静默 */ }
  }

  /* 人物发图片：img() 生成符合人设的照片 */
  function charPhotoUrl(c) {
    const who = c.gender === 'male' ? 'young Chinese man' : 'young Chinese woman';
    return img(`award-winning photorealistic portrait photograph of a ${who}, golden hour soft natural lighting, shallow depth of field, film grain, casual stylish outfit, cozy indoor scene, sharp focus on face, high detail skin texture, professional photography, no text, no watermark`, 'square_hd');
  }
  /* 只在用户提到照片/自拍时发图，不再随机自发（生成图质量不可控且容易加载失败） */
  function maybeSendPhoto(c, userText) {
    const want = /照片|自拍|图片|发个图|看看你|拍张/.test(userText || '');
    if (!want) return;
    setTimeout(() => {
      pushCustomMsg(c.id, { from: 'them', type: 'img', url: charPhotoUrl(c) });
      renderCustomChat(c.id);
    }, 1600);
  }

  window.VXCustom = {
    current: null,
    mountChatList, mountMe, unreadTotal, svgLetter,
    openCustomChat, renderCustomChat, pushCustomMsg, openCustomForm, makeReply,
    openEmojiPanel, bindChatInputs, updatePlusBtn,
    get customSystemPrompt() { return customSystemPrompt; },
    get customLLM() { return customLLM; }
  };
  // custom.js 在 app.js 之后加载，此时 renderChats/renderMe 已执行但 VXCustom 还不存在，
  // 所以这里主动再调一次，把定制入口注入聊天列表和我的页面
  renderChats();
  if (typeof VX.renderMe === 'function') VX.renderMe();
})();
