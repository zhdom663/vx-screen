/* ============================================================
 * VX 朋友圈模块：时间线 / 点赞评论 / 雄竞 / 发圈 / 资料
 * ============================================================ */
(function () {
  const { db, save, uid, esc, toast, openSheet, closeSheet, showPage, renderChats,
    getChar, CHARACTERS, callLLM, fmtHM, fmtClock, pad2, svgMe, img } = VX;

  /* ---------------- 角色头像辅助 ---------------- */
  function authorAvatar(m) {
    if (m.authorType === 'me') return db.profile.avatar || svgMe();
    if (m.authorType === 'builtin') return getChar(m.authorId)?.avatar || svgMe();
    const c = db.customs.find(x => x.id === m.authorId);
    return c?.avatar || (window.VXCustom ? VXCustom.svgLetter(c?.name || '') : svgMe());
  }
  function authorName(m) {
    if (m.authorType === 'me') return db.profile.name || '我';
    if (m.authorType === 'builtin') return getChar(m.authorId)?.name || '';
    const c = db.customs.find(x => x.id === m.authorId);
    return c?.name || '';
  }

  /* ---------------- 预置朋友圈（首次启动 seed） ---------------- */
  function seedMoments() {
    /* 数据迁移：修复旧数据里 authorId 拼写错误 xnn → xunn */
    db.moments.forEach(m => { if (m.authorId === 'xnn') m.authorId = 'xunn'; });
    if (db.momentsSeedV === 3) return;
    /* v3：预置角色下线，清空内置圈文（保留用户自己发的） */
    if (db.momentsSeedV !== 3) {
      db.moments = db.moments.filter(m => m.authorType === 'me');
    }
    db.momentsSeedV = 3;
    save();
  }

  /* ---------------- 定制角色按人设发圈（低频 · 符合人设 · 纯文字） ---------------- */
  /* 每个角色有固定发圈节奏：半天~两天一条，随机生成后记住 */
  function momentGapOf(c) {
    if (!c.momentGap) c.momentGap = 12 + Math.random() * 36;   // 12~48 小时
    return c.momentGap * 3600 * 1000;
  }
  function maybeCharMoments() {
    const acc = db.customs.filter(c => c.friendStatus === 'accepted');
    const c = acc.find(c => (!c.lastMomentTs || Date.now() - c.lastMomentTs > momentGapOf(c)) && Math.random() < 0.35);
    if (c) genCharMoment(c);
  }
  async function genCharMoment(c) {
    c.lastMomentTs = Date.now(); c.momentGap = 0; save();   // 占位防重入，发完重置节奏
    try {
      const sys = `你是${esc(c.name)}，一个真实存在的人，正在发微信朋友圈。
【你的性格】${c.persona.personality}
【你和用户的关系】${c.persona.relation}
【完整人设（最高优先级，绝不OOC）】${(c.persona.background || '你们关系亲近。').slice(0, 2000)}
【说话风格】${c.persona.style || '口语短句'}
【铁律】1. 内容必须是这个身份的人会发的真实日常/心情/吐槽/分享，绝不能出现AI腔、客服腔、鸡汤味。2. 语言风格、口头禅、关注点必须严格贴合人设。3. 人设里没提到的设定（职业/店铺/经历/爱好等）绝不编造。4. 不@任何人，纯文字不发图。5. 先按人设判断：如果你这个性格的人本来就不爱发朋友圈（高冷、低调、话少、懒得分享），只输出[SKIP]，爱分享的人才发。
以${c.name}的身份发一条朋友圈，口语化，25字以内。只输出正文。`;
      const raw = await callLLM(sys, [{ role: 'user', content: '发一条朋友圈' }], 0.9, 30000);
      if (/^\[SKIP\]$/i.test(String(raw).trim())) return;   // 这个人不爱发圈
      const text = trimSentence(String(raw).split('\n').map(s => s.trim().replace(/^["「『]|["」』]$/g, '')).filter(Boolean)[0] || '');
      if (!text) return;
      const m = { id: uid(), authorType: 'custom', authorId: c.id, text, images: [], ts: Date.now(), likes: [], comments: [] };
      db.moments.push(m); save();
      if (document.querySelector('.page.active')?.id === 'page-moments') render();
      /* 其他角色按各自人设与关系来评论（雄竞） */
      setTimeout(() => triggerMaleCompetition(m), 2500);
    } catch (e) { /* 静默 */ }
  }

  /* ---------------- 渲染朋友圈 ---------------- */
  function render() {
    seedMoments();
    maybeCharMoments();
    const cover = db.profile.cover || img('beautiful dreamy night sky with stars and soft gradient, aesthetic wallpaper', 'landscape_16_9');
    const myAvatar = db.profile.avatar || svgMe();
    const list = db.moments.slice().sort((a, b) => b.ts - a.ts).map(m => renderMoment(m)).join('');
    const wrap = document.getElementById('momentsWrap');
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="moments-cover" style="background-image:url('${cover}'), linear-gradient(135deg,#3a1c71,#5f6d8a)">
        <div class="moments-me">
          <span>${esc(db.profile.name || '我')}</span>
          <img class="avatar" src="${myAvatar}" data-act="edit-profile">
        </div>
      </div>
      <div class="moments-actions">
        <button class="wx-primary sm" data-act="new-moment">发朋友圈</button>
      </div>
      <div class="moments-list">${list || '<div class="empty">还没有朋友圈</div>'}</div>
    `;
  }

  function renderMoment(m) {
    /* 生成图源失败时先切 picsum 图库，再失败整块隐藏（保证不破图） */
    const fbAttr = `onerror="this.onerror=()=>{const g=this.closest('.m-imgs');if(g)g.style.display='none';};this.src='https://picsum.photos/seed/vx'+(Math.random()*900|0)+'/600/600';"`;
    const imgs = m.images?.length ? `<div class="m-imgs ${m.images.length===1?'one':''}">${m.images.map(u=>`<img src="${u}" data-fb="1" ${u.startsWith('data:') ? '' : fbAttr}>`).join('')}</div>` : '';
    const likes = m.likes.length ? `<div class="m-likes">❤️ ${m.likes.map(id=>nameOf(id)).join('、')}</div>` : '';
    const comments = m.comments.map(c => `<div class="m-comment" data-act="reply-comment" data-id="${m.id}" data-name="${esc(c.fromName)}"><b>${esc(c.fromName)}${c.replyTo ? `<i class="m-replyto"> 回复 ${esc(c.replyTo)}</i>` : ''}：</b>${esc(c.text)} <span class="m-act">回复</span></div>`).join('');
    const liked = m.likes.includes('me');
    return `<div class="moment">
      <img class="m-avatar" src="${authorAvatar(m)}">
      <div class="m-body">
        <div class="m-name">${esc(authorName(m))}</div>
        <div class="m-text">${esc(m.text)}</div>
        ${imgs}
        <div class="m-time">${fmtClock(m.ts)} <span class="m-act" data-act="like-moment" data-id="${m.id}">${liked?'已赞':'赞'}</span> <span class="m-act" data-act="comment-moment" data-id="${m.id}">评论</span></div>
        ${likes || comments ? `<div class="m-interact">${likes}${comments}</div>` : ''}
      </div>
    </div>`;
  }

  function nameOf(id) {
    if (id === 'me') return db.profile.name || '我';
    const c = getChar(id); if (c) return c.name;
    const cu = db.customs.find(x => x.id === id); return cu?.name || '';
  }

  /* ---------------- 点赞 ---------------- */
  function likeMoment(id) {
    const m = db.moments.find(x => x.id === id); if (!m) return;
    const i = m.likes.indexOf('me');
    if (i >= 0) m.likes.splice(i, 1);
    else {
      m.likes.push('me');
      // 触发雄竞评论
      triggerMaleCompetition(m);
    }
    save(); render();
  }

  /* ---------------- 评论 ---------------- */
  let replyTarget = '';   // 当前回复对象的名字（空 = 普通评论）
  function commentMoment(id) {
    const m = db.moments.find(x => x.id === id); if (!m) return;
    replyTarget = '';
    openCommentSheet(id, authorName(m));
  }
  function replyComment(id, name) {
    const m = db.moments.find(x => x.id === id); if (!m) return;
    replyTarget = name || '';
    openCommentSheet(id, name);
  }
  function openCommentSheet(id, name) {
    openSheet(`
      <div class="form-title">${replyTarget ? '回复 ' + esc(replyTarget) : '评论「' + esc(name) + '」的朋友圈'}</div>
      <div class="form-row"><input id="cmtInput" placeholder="${replyTarget ? '回复 ' + esc(replyTarget) + '...' : '说点什么...'}" maxlength="60"></div>
      <button class="wx-primary" data-act="submit-comment" data-id="${id}">发送</button>
    `);
    setTimeout(() => {
      const inp = document.getElementById('cmtInput');
      if (inp) inp.focus();
    }, 50);
  }

  function submitComment(id) {
    const m = db.moments.find(x => x.id === id); if (!m) return;
    const text = document.getElementById('cmtInput').value.trim();
    if (!text) return;
    m.comments.push({ from: 'me', fromName: db.profile.name || '我', text, replyTo: replyTarget || '', ts: Date.now() });
    save(); closeSheet(); render();
    const rt = replyTarget; replyTarget = '';
    // 我评论了定制角色的朋友圈：TA 要回复我（微信同款）
    if (m.authorType === 'custom') scheduleAuthorReply(m, text);
    // 触发其他角色评论（雄竞）
    triggerMaleCompetition(m);
  }

  /* 我评论定制角色的朋友圈后，作者按人设回复我 */
  function scheduleAuthorReply(m, myText) {
    const author = db.customs.find(x => x.id === m.authorId);
    if (!author) return;
    setTimeout(async () => {
      const mm = db.moments.find(x => x.id === m.id); if (!mm) return;
      let text = '';
      try {
        const raw = await callLLM(`你是${esc(author.name)}，一个真实存在的人。
【你的性格】${author.persona.personality}
【你和用户的关系】${author.persona.relation}
【完整人设（最高优先级，绝不OOC）】${(author.persona.background || '').slice(0, 1500)}
【说话风格】${author.persona.style || '口语短句'}
你发的朋友圈（"${esc(String(m.text).slice(0, 60))}"）下收到用户的评论："${esc(myText)}"。以${author.name}的身份、性格和口吻在评论区回复TA，15字内，口语化，严格贴合人设，不要AI腔；回复里不要叫TA的名字，直接说想说的话；绝不编造人设里没有的设定；不重复你之前说过的话。只输出回复文本。`, [], 0.95, 30000);
        text = trimSentence(raw);
      } catch (e) { text = ''; }
      if (!text) text = ['哈哈你说得对', '那必须的呀', '你也一起来嘛'][Math.floor(Math.random() * 3)];
      mm.comments.push({ from: author.id, fromName: author.name, text, ts: Date.now() });
      save();
      if (document.getElementById('page-moments')?.classList.contains('active')) render();
    }, 3500 + Math.random() * 5000);
  }

  /* ---------------- 世界认知：同作品角色互相认识 ---------------- */
  const KNOWN_WORLDS = ['时空中的绘旅人', '绘旅人', '破云', '吞海', '默读', '伪装学渣', '魔道祖师', '天官赐福', '全球高考', '小蘑菇', '残次品', '人鱼陷落', '某某', '撒野', '死亡万花筒'];
  /* 角色所属作品：优先取创建时填写的"出自作品"，否则从人设文本里自动识别 */
  function charWorld(cu) {
    if (!cu) return '';
    if (cu.world) return String(cu.world).trim();
    const t = `${cu.persona?.background || ''} ${cu.persona?.relation || ''} ${cu.name || ''}`;
    const hit = KNOWN_WORLDS.find(w => t.includes(w));
    return hit || '';
  }
  function worldsMatch(a, b) {
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  /* ---------------- 雄竞：按"谁认识谁"决定谁能评论 ---------------- */
  async function triggerMaleCompetition(m) {
    const candidates = [];
    CHARACTERS.forEach(c => { if (c.id !== m.authorId) candidates.push({ type: 'builtin', id: c.id, name: c.name }); });
    db.customs.filter(c => c.friendStatus === 'accepted' && c.id !== m.authorId).forEach(c => candidates.push({ type: 'custom', id: c.id, name: c.name }));

    /* 正文里被点名的定制角色：必须以当事人身份回应（如"叶瑄是混蛋"→叶瑄本人求原谅） */
    const mentionIds = new Set(
      db.customs.filter(c => c.friendStatus === 'accepted' && c.id !== m.authorId && String(m.text || '').includes(c.name)).map(c => c.id)
    );

    let picked = [];
    if (m.authorType === 'me') {
      /* 用户发的朋友圈：列表里所有人（已接受的定制角色）都必须点赞或评论，点名者最优先 */
      const mentionList = db.customs.filter(c => mentionIds.has(c.id)).map(c => ({ type: 'custom', id: c.id, name: c.name }));
      const rest = db.customs
        .filter(c => c.friendStatus === 'accepted' && !mentionIds.has(c.id))
        .sort(() => Math.random() - 0.5)
        .map(c => ({ type: 'custom', id: c.id, name: c.name }));
      picked = [...mentionList, ...rest];
    } else {
      /* 角色发的朋友圈：只允许同一作品世界（人设里互相认识）的角色评论；被点名者除外 */
      const author = db.customs.find(x => x.id === m.authorId);
      const aw = charWorld(author);
      picked = candidates.filter(c => {
        if (mentionIds.has(c.id)) return true;
        if (c.type !== 'custom') return false;   // 预设角色与定制角色不在同一作品，不认识作者就不评
        const cu = db.customs.find(x => x.id === c.id);
        return worldsMatch(aw, charWorld(cu));
      }).sort(() => Math.random() - 0.5).slice(0, 2);
    }
    for (const cand of picked) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      const text = await genCompetitionComment(cand, m, { isMentioned: mentionIds.has(cand.id) });
      /* [L] = 按人设只会点赞，不评论（高冷/话少的人） */
      if (text === '[L]') {
        const mm = db.moments.find(x => x.id === m.id); if (!mm) continue;
        if (!mm.likes.includes(cand.id)) mm.likes.push(cand.id);
        save();
        if (document.getElementById('page-moments')?.classList.contains('active')) render();
        continue;
      }
      if (!text) continue;
      m.comments.push({ from: cand.id, fromName: cand.name, text, ts: Date.now() });
      save();
      if (document.getElementById('page-moments')?.classList.contains('active')) render();
    }
  }

  /* 截掉被超时切断的半句话：超长且结尾无标点时回切到最后一个标点 */
  function trimSentence(raw) {
    let t = String(raw || '').replace(/<[^>]+>/g, '').replace(/^["“”']+|["“”']+$/g, '').split(/\n+/)[0].trim();
    if (!t) return '';
    if (t.length > 40) t = t.slice(0, 40);
    if (t.length > 18 && !/[。！？～…，,.!?~]$/.test(t)) {
      const p = Math.max(t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('？'), t.lastIndexOf('～'), t.lastIndexOf('，'), t.lastIndexOf('~'));
      if (p >= 8) t = t.slice(0, p + 1);
    }
    return t;
  }

  async function genCompetitionComment(cand, m, opts = {}) {
    // 构建人设
    let persona, relation, background = '';
    let candWorld = '';
    if (cand.type === 'builtin') {
      const c = getChar(cand.id);
      persona = c.personality || '性格鲜明';
      relation = c.relation || '和用户关系亲近';
    } else {
      const c = db.customs.find(x => x.id === cand.id);
      if (!c) return null;
      persona = c.persona.personality;
      relation = c.persona.relation;
      background = c.persona.background || '';
      candWorld = charWorld(c);
    }
    const author = authorName(m);
    /* 情敌检测：评论者与作者都和用户是恋人系关系时，开启情敌雄竞模式 */
    const lovey = /男友|男朋友|恋人|老公|男票|对象|爱人/;
    const candLove = lovey.test(String(relation)) || lovey.test(String(background).slice(0, 500));
    let authorLove = false;
    if (m.authorType === 'custom') {
      const a = db.customs.find(x => x.id === m.authorId);
      if (a) authorLove = lovey.test(a.persona.relation) || lovey.test(String(a.persona.background || '').slice(0, 500));
    }
    const rival = candLove && authorLove;
    const existing = m.comments.slice(-4).map(c => c.text).filter(Boolean).join('｜');
    /* 当事人：这条朋友圈正文点名了评论者本人（如"叶瑄是混蛋"→叶瑄必须回应） */
    const isMentioned = !!opts.isMentioned;
    /* 正文点名的其他角色：评论者认识谁、不认识谁（按作品世界判断） */
    const others = db.customs.filter(x =>
      x.friendStatus === 'accepted' && x.id !== cand.id && x.id !== m.authorId && String(m.text || '').includes(x.name));
    const known = [], unknown = [];
    others.forEach(x => (worldsMatch(candWorld, charWorld(x)) ? known : unknown).push(x.name));
    let cognition = '';
    if (isMentioned) cognition += `这条朋友圈点名提到了你本人！必须以你的身份回应：被夸就自然接住，被吐槽（如"混蛋"）就辩解、求原谅、抗议或撒娇，符合你的性格，别不当回事。\n`;
    if (known.length) cognition += `正文里提到的${known.join('、')}是跟你同一世界、彼此认识的人，可以自然接梗互动。\n`;
    if (unknown.length) cognition += `正文里提到的${unknown.join('、')}你不认识（不是你那个世界的人），绝不装熟，可以好奇地问TA是谁。\n`;
    const sys = `你是${esc(cand.name)}，一个真实的人。
【你的性格】${persona}
【你和用户的关系】${relation}
【你的完整人设，绝不OOC】${background.slice(0, 2000)}
【铁律】人设里没提到的设定（职业/店铺/经历/爱好等）绝不编造。
${rival ? `【重要】${esc(author)}和你一样，都是用户的恋人，你们互为情敌。评论时可以争风吃醋、暗中较劲、宣示主权（像"这种活动下次该我陪TA去吧"），但语气自然，像熟人之间的较劲，不刻意。\n` : ''}你刷到了${esc(author)}发的朋友圈："${esc(m.text)}"${m.images && m.images.length ? '（配了图）' : ''}。
${cognition}请以你的身份写一条朋友圈评论：
1. 评论必须针对这条朋友圈的正文内容做出具体回应（比如TA说想出去玩，你可以问去哪玩、让他带上你，或表达想一起去）。
2. 严格符合你的性格：话少、高冷、低调的人通常只点赞不评论——如果按人设你只会点赞，就只输出[L]。
3. 不要客服腔、不要AI腔、不要敷衍。可以对用户有好感、微妙吃醋、宣示存在感，但要自然不刻意。
4. 评论里绝不叫对方的名字，直接说想说的话。
5. 绝不重复已有评论说过的话，也不重复自己之前说过的话。
${existing ? `6. 已有评论（绝不重复或雷同）：${existing}\n` : ''}只输出评论文本或[L]，25字以内，完整一句话，不加引号前缀。`;
    try {
      const raw = await callLLM(sys, [], 0.95, 30000);
      if (/^\[L\]$/i.test(String(raw).trim())) return '[L]';
      const t = trimSentence(raw);
      /* 防重复：与已有评论相同或高度相似 → 重试一次 → 仍重复走兜底 */
      const oldList = existing ? existing.split('｜') : [];
      const isDup = t && oldList.some(e => e === t || (Math.min(e.length, t.length) >= 6 && (e.includes(t) || t.includes(e))));
      if (isDup) {
        try {
          const raw2 = await callLLM(sys + '\n（换个说法，绝不能和已有评论重复或雷同）', [], 0.95, 30000);
          if (/^\[L\]$/i.test(String(raw2).trim())) return '[L]';
          const t2 = trimSentence(raw2);
          if (t2 && !oldList.some(e => e === t2 || (Math.min(e.length, t2.length) >= 6 && (e.includes(t2) || t2.includes(e))))) return t2;
        } catch (e) { }
        return pickGenericComment(cand, m);
      }
      if (t) return t;
    } catch (e) { /* 忽略 */ }
    return pickGenericComment(cand, m);
  }

  /* LLM 不可用时的兜底：按正文内容生成有逻辑的评论，不再敷衍 */
  function pickGenericComment(cand, m) {
    const t = String(m.text || '');
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    if (/出去玩|出门|旅游|逛|散心/.test(t)) return pick(['去哪玩？带上我', '也想出去透透气，算我一个', '行啊，记得拍照给我看']);
    if (/吃|饭|蛋糕|奶茶|美食/.test(t)) return pick(['看着就好吃，我也要', '下次一起啊', '又吃好的不带我？']);
    if (/累|加班|难过|烦|emo/.test(t)) return pick(['怎么了？跟我说说', '别太累，早点休息', '我在呢，想聊随时找我']);
    if (/喜欢|爱你|想你/.test(t)) return pick(['说的谁，清楚了吗', '嗯，收到了', '那我当真了']);
    if (m.images && m.images.length) return pick(['这张拍得可以啊', '在哪拍的？', '照片不错，人更好看']);
    return pick(['哦？然后呢', '看到啦，回来说', '嗯嗯，记下了']);
  }

  /* ---------------- 发朋友圈（微信风全屏编辑页） ---------------- */
  let composerImgs = [];
  function newMoment() {
    composerImgs = [];
    document.getElementById('nmText').value = '';
    renderComposerImgs();   // 必须渲染，否则不显示「＋添加图片」格子
    document.getElementById('momComposer').style.display = 'flex';
  }
  function closeComposer() { document.getElementById('momComposer').style.display = 'none'; }

  async function compressMomentImg(file, max = 1280) {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload = () => {
        const im = new Image();
        im.onload = () => {
          const scale = Math.min(1, max / Math.max(im.width, im.height));
          const c = document.createElement('canvas');
          c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        im.onerror = () => resolve('');
        im.src = r.result;
      };
      r.onerror = () => resolve('');
      r.readAsDataURL(file);
    });
  }

  function renderComposerImgs() {
    const grid = document.getElementById('momImgGrid');
    grid.innerHTML = composerImgs.map((u, i) =>
      `<div class="mom-img-cell"><img src="${u}" data-fb="1"><i class="mom-img-del" data-act="moment-del-img" data-i="${i}">✕</i></div>`
    ).join('') + (composerImgs.length < 9 ? `<div class="mom-img-cell add" data-act="pick-moment-img">＋</div>` : '');
  }

  function submitMoment() {
    const text = document.getElementById('nmText').value.trim();
    if (!text && !composerImgs.length) return toast('写点什么吧');
    const m = {
      id: uid(), authorType: 'me', authorId: 'me',
      text, images: composerImgs.slice(),
      ts: Date.now(), likes: [], comments: []
    };
    db.moments.push(m);
    save(); closeComposer(); render();
    toast('已发表', 1000);
    // 角色按人设评论（雄竞）
    triggerMaleCompetition(m);
    // 角色会给我的朋友圈点赞
    scheduleCharLikes(m);
    // 若我一直没理 TA，角色会主动私聊提起这条朋友圈
    scheduleMomentFollowup(m);
  }

  /* 角色点赞我的朋友圈（延时出现，微信同款社交感） */
  function scheduleCharLikes(m) {
    const acc = db.customs.filter(c => c.friendStatus === 'accepted');
    if (!acc.length) return;
    const picked = acc.slice().sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.4 ? 2 : 1);
    picked.forEach((c, i) => setTimeout(() => {
      const mm = db.moments.find(x => x.id === m.id); if (!mm) return;
      if (!mm.likes.includes(c.id)) mm.likes.push(c.id);
      save();
      if (document.getElementById('page-moments')?.classList.contains('active')) render();
    }, 6000 + i * 5000 + Math.random() * 6000));
  }

  /* 我发圈后一段时间没和角色说话，TA 会主动私聊提起这条朋友圈 */
  function scheduleMomentFollowup(m) {
    const acc = db.customs.filter(c => c.friendStatus === 'accepted');
    if (!acc.length || !window.VXCustom || !VXCustom.customLLM) return;
    const c = acc[Math.floor(Math.random() * acc.length)];
    const t0 = Date.now();
    setTimeout(async () => {
      const cu = db.customs.find(x => x.id === c.id); if (!cu) return;
      const lastMe = [...cu.chats].reverse().find(msg => msg.from === 'me');
      if (lastMe && lastMe.ts > t0) return;   // 用户已经去找 TA 聊了就不打扰
      let lines = null;
      try {
        lines = await VXCustom.customLLM(cu,
          `（你刚刷到用户发的朋友圈："${String(m.text).slice(0, 60)}"${m.images && m.images.length ? '，还配了图' : ''}。按你的性格主动找TA聊聊这条朋友圈，可以好奇、调侃、顺着内容约TA，1-2条口语短消息）`,
          [], 'text');
      } catch (e) { lines = null; }
      if (!lines || !lines.length) lines = ['刷到你朋友圈了', '在忙什么呀'];
      lines.slice(0, 2).forEach((t, i) =>
        setTimeout(() => VXCustom.pushCustomMsg(cu.id, { from: 'them', type: 'text', text: t }), i * 900));
    }, 50000 + Math.random() * 20000);
  }

  /* ---------------- 资料编辑（微信风全屏页） ---------------- */
  function editProfile() {
    const pf = db.profile;
    const body = document.getElementById('profileBody');
    if (!body) return;
    body.innerHTML = `
      <div class="form-row"><label>头像</label>
        <div class="avatar-upload" data-act="pick-my-avatar">
          <img id="pfAvatar" src="${pf.avatar || svgMe()}"><span>点击上传</span>
        </div>
        <input type="file" id="pfAvatarInput" accept="image/*" hidden>
      </div>
      <div class="form-row"><label>昵称</label>
        <input id="pfName" value="${esc(pf.name || '')}" maxlength="12">
      </div>
      <div class="form-row"><label>个签</label>
        <input id="pfBio" value="${esc(pf.bio || '')}" placeholder="写一句个性签名，会显示在「我的」页面" maxlength="30">
      </div>
      <div class="form-row"><label>朋友圈封面</label>
        <div class="avatar-upload cover-upload" data-act="pick-my-cover">
          <img id="pfCoverImg" src="${pf.cover || svgMe()}" style="width:100%;height:110px;border-radius:10px;object-fit:contain;background:#3a3a3c"><span id="pfCoverTxt">${pf.cover ? '点击更换' : '点击上传'}</span>
        </div>
        <input type="file" id="pfCoverInput" accept="image/*" hidden>
      </div>
      <button class="wx-primary" data-act="save-profile" style="margin-top:14px">保存</button>
    `;
    document.getElementById('profilePage').style.display = 'flex';
    setTimeout(bindProfileForm, 0);
  }

  let pendingCover = '';
  function bindProfileForm() {
    const inp = document.getElementById('pfAvatarInput');
    if (inp) inp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { document.getElementById('pfAvatar').src = r.result; };
      r.readAsDataURL(f);
    };
    const cov = document.getElementById('pfCoverInput');
    if (cov) cov.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const url = await compressMomentImg(f, 1600);
      if (!url) return toast('图片读取失败');
      pendingCover = url;
      document.getElementById('pfCoverImg').src = url;
      document.getElementById('pfCoverTxt').textContent = '点击更换';
    };
  }

  function saveProfile() {
    const av = document.getElementById('pfAvatar').src;
    const name = document.getElementById('pfName').value.trim() || '我';
    const bio = document.getElementById('pfBio').value.trim();
    db.profile.name = name;
    db.profile.bio = bio;
    if (pendingCover) { db.profile.cover = pendingCover; pendingCover = ''; }
    if (av && av.startsWith('data:')) {
      // 压缩头像：只缩小不放大、不裁剪，保持原图比例
      try {
        const im = new Image();
        im.onload = () => {
          const scale = Math.min(1, 256 / Math.max(im.width, im.height));
          const w = Math.max(1, Math.round(im.width * scale));
          const h = Math.max(1, Math.round(im.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          db.profile.avatar = c.toDataURL('image/jpeg', 0.82);
          finishProfile();
        };
        im.src = av;
      } catch (e) { finishProfile(); }
    } else finishProfile();
  }

  function finishProfile() {
    save();
    document.getElementById('profilePage').style.display = 'none';
    render();
    if (typeof renderMe === 'function') renderMe();
    else if (VX.renderMe) VX.renderMe();
    toast('已保存', 1000);
  }

  /* ---------------- 我的页面钩子 ---------------- */
  function mountMe() {
    // 朋友圈入口已在 custom.js 加，这里可加额外
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const act = t.dataset.act, id = t.dataset.id;
    switch (act) {
      case 'new-moment': newMoment(); break;
      case 'submit-moment': submitMoment(); break;
      case 'mom-back': closeComposer(); break;
      case 'pick-moment-img': document.getElementById('momImgInput')?.click(); break;
      case 'moment-del-img': composerImgs.splice(+t.dataset.i, 1); renderComposerImgs(); break;
      case 'freq-back': document.getElementById('freqPage').style.display = 'none'; break;
      case 'pf-back': document.getElementById('profilePage').style.display = 'none'; break;
      case 'like-moment': likeMoment(id); break;
      case 'comment-moment': commentMoment(id); break;
      case 'submit-comment': submitComment(id); break;
      case 'edit-profile': editProfile(); break;
      case 'pick-my-avatar': document.getElementById('pfAvatarInput')?.click(); break;
      case 'pick-my-cover': document.getElementById('pfCoverInput')?.click(); break;
      case 'save-profile': saveProfile(); break;
      case 'reply-comment': replyComment(id, el.dataset.name || ''); break;
    }
  });

  /* ---------------- 新的朋友（微信风全屏页） ---------------- */
  function renderFreqPage() {
    const pg = document.getElementById('freqPage');
    if (!pg) return;
    const list = db.friendReqs.slice().reverse().map(r => {
      const c = db.customs.find(x => x.id === r.customId);
      if (!c) return '';
      const accepted = r.status === 'accepted';
      return `<div class="freq-row">
        <img class="avatar" src="${c.avatar || svgMe()}">
        <div class="freq-info">
          <div class="freq-name">${esc(c.name)}</div>
          <div class="freq-msg">${esc(r.msg || '请求加你为好友')}</div>
        </div>
        ${accepted
          ? '<span class="freq-done">已接受</span>'
          : `<button class="wx-primary sm" data-act="accept-friend" data-id="${r.customId}">接受</button>`}
      </div>`;
    }).join('');
    document.getElementById('freqList').innerHTML = list || '<div class="empty">暂无新的朋友</div>';
    pg.style.display = 'flex';
  }

  /* 多图上传绑定 */
  document.addEventListener('DOMContentLoaded', () => {
    const mi = document.getElementById('momImgInput');
    if (mi) mi.onchange = async e => {
      const files = [...e.target.files].slice(0, 9 - composerImgs.length);
      for (const f of files) {
        const u = await compressMomentImg(f);
        if (u) composerImgs.push(u);
      }
      renderComposerImgs();
      e.target.value = '';
    };
  });

  window.VXMoments = { render, mountMe, seedMoments, renderFreqPage, maybeCharMoments, genCharMoment };

  /* 定时器：即使不打开朋友圈页，角色也会按人设主动发圈 */
  setTimeout(() => { try { maybeCharMoments(); } catch (e) { } }, 8000);   // 启动后尽快触发一次
  if (!window._vxMomentTimer) {
    window._vxMomentTimer = setInterval(() => {
      try { maybeCharMoments(); } catch (e) { }
    }, 20 * 60 * 1000);
  }
})();
