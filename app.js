/* =========================================================
 * VX 屏幕陪伴 —— 真实屏幕识别 + 主动发消息
 * 采集：getDisplayMedia ｜ 去重：aHash 感知哈希
 * 识别：Tesseract.js 本地 OCR（默认）/ OpenAI 兼容视觉大模型
 * 生成：真人聊天引擎（角色卡 + 多轮上下文 + DeepSeek）/ 本地话术兜底
 * ========================================================= */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad2 = n => String(n).padStart(2, '0');
const fmtClock = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const fmtHM = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
function toast(msg, ms = 2000) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.display = 'none'), ms);
}

/* ---------------- 角色（SillyTavern 式角色卡：人设 + 语言习惯 + 示例对话） ---------------- */
/* ---------------- 角色：预设角色已下线，全部改为定制角色 ---------------- */
const CHARACTERS = [];
const getChar = id => CHARACTERS.find(c => c.id === id) || null;


/* 话题关键词分类器（OCR 文本 → 话题） */
const TOPIC_RULES = [
  ['美食', /美食|外卖|奶茶|烤|火锅|烧烤|蛋糕|咖啡|拉面|焖饭|好吃|餐厅|小吃|宵夜|夜宵|吃播|甜品|拿铁/],
  ['购物', /淘宝|京东|拼多多|下单|购物车|种草|口红|优惠券|折扣|包邮|测评|拼单|闲鱼|价格|¥|划算/],
  ['游戏', /游戏|王者|原神|英雄联盟|吃鸡|开黑|段位|主播|电竞|抽卡|副本|直播打/],
  ['学习', /考研|高数|英语|四级|六级|python|java|代码|编程|公式|网课|课程|真题|知识点|作业|讲义|课堂/],
  ['视频娱乐', /抖音|小红书|快手|b站|哔哩|视频|综艺|电视剧|电影|短剧|vlog|热播/],
  ['社交', /朋友圈|点赞|评论|聊天|微信|qq|群聊|私信|留言|转发/],
  ['工作新闻', /会议|报表|邮件|deadline|加班|招聘|新闻|通知|公告|方案|汇报|绩效/]
];
function classifyTopic(text) {
  for (const [topic, reg] of TOPIC_RULES) if (reg.test(text)) return topic;
  return '其他';
}
const SCHEDULED_LINES = {
  noon: ['吃饭了吗？别又忙到忘记时间。', '午间提醒：起来接杯水，活动两分钟。'],
  eve: ['今天过得怎么样？有空跟我说说。', '夜深了，别把弦绷太紧，放松一下。']
};

/* ---------------- 存储 ---------------- */
const LS_KEY = 'vxscreen_v1';
let db = null;
function seedDB() {
  const now = Date.now();
  return {
    settings: {
      engine: 'ocr',
      intervalSec: 5,
      cooldownSec: 20,
      sensitivity: 'mid',          // high=6 / mid=12 / low=20
      targetId: '',
      deepseekKey: '',   // 不内置 Key（公开仓库安全要求）：首次使用到「我的 → DeepSeek 文案生成」填入自己的 Key，填一次即可
      vision: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: '', model: 'qwen-vl-max' },
      scheduled: true
    },
    unread: {},
    chats: {},
    recLog: [],
    stats: { frames: 0, pushed: 0, skipped: 0 },
    schedKeys: [],
    /* v2 扩展：定制人物 / 朋友圈 / 好友申请 / 个人资料 */
    customs: [],          // 付费定制的人物
    moments: [],          // 朋友圈时间线
    friendReqs: [],       // 好友申请
    profile: { name: '我', avatar: '', cover: '' },
    wallet: { balance: 6534.00, redpacks: [] },
    /* v3 扩展：深色模式 / 多身份 / 心动审判 / 角色心情 */
    dark: true,    // 默认深色 North 风
    identities: [{ id: 'id_default', name: '我', avatar: '', wcid: 'wx_me' }],
    curIdent: 'id_default',
    trial: { answers: [], dims: { 默契: 0, 占有: 0, 沉沦: 0, 反抗: 0, 危险: 0 } },
    mood: {},   // charId -> {text, ts}
    /* v4 扩展：微信步数 / 在线状态 / 全局人设 */
    steps: 98,
    stepsCounting: true,
    online: 'auto',        // auto / online / offline
    globalPersona: '',     // 我的人设（所有角色可见）
    /* v5 扩展：小手机体验（锁屏/皮肤/备注/拉黑/卡片） */
    lock: { enabled: true, password: '12345' },
    skin: 'pink',           // pink / green / white / imessage
    remarks: {},           // charId -> 备注名
    blocked: [],           // 拉黑的角色
    lastCard: {}            // charId -> 上次发卡片的时间戳
  };
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  catch (e) { toast('存储空间不足，视频/大图请减小后重试'); }
}
function load() {
  try { db = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { db = null; }
  if (!db || !db.chats || typeof db.chats !== 'object') db = seedDB();
  const seed = seedDB();
  db.settings = Object.assign(seed.settings, db.settings || {});
  // v23：未配置 Key 的旧数据自动补默认 Key，保证 AI 生成开箱可用
  if (!db.settings.deepseekKey) db.settings.deepseekKey = seed.settings.deepseekKey;
  // 迁移：旧版冷却 60 秒太长，自动降到 20 秒
  if (db.settings.cooldownSec > 30) db.settings.cooldownSec = 20;
  ['customs', 'moments', 'friendReqs', 'wallet', 'identities', 'trial'].forEach(k => { if (db[k] == null) db[k] = seed[k]; });
  if (!db.profile || typeof db.profile !== 'object') db.profile = seed.profile;
  if (typeof db.dark !== 'boolean') db.dark = true;
  // v6 迁移：默认切换到深色 North 风（仅首次）
  if (!db._themeV6) { db.dark = true; db._themeV6 = true; }
  if (!db.curIdent) db.curIdent = seed.curIdent;
  if (!db.mood || typeof db.mood !== 'object') db.mood = {};
  if (!db.trial.dims) db.trial.dims = seed.trial.dims;
  if (typeof db.steps !== 'number') db.steps = 98;
  if (typeof db.stepsCounting !== 'boolean') db.stepsCounting = true;
  if (!db.online) db.online = 'auto';
  if (typeof db.globalPersona !== 'string') db.globalPersona = '';
  if (!db.wallet) db.wallet = { balance: 6534, redpacks: [] };
  if (typeof db.wallet.balance !== 'number') db.wallet.balance = 6534;
  // 模拟钱包：余额为 0 时给个初始值（演示用，非真实金额）
  if (db.wallet.balance === 0) db.wallet.balance = 6534;
  // v8 迁移：给已有用户初始化步数（仅一次）
  if (!db._v8defaults) {
    if (db.steps === 0) db.steps = 98;
    db._v8defaults = true;
  }
  // v20 迁移：删除预设角色（沈慕朝/许念念）的历史数据，全部改为定制角色
  if (!db._v20noPreset) {
    delete db.chats.shenmz; delete db.chats.xunn;
    delete db.unread.shenmz; delete db.unread.xunn;
    if (db.settings.targetId === 'shenmz' || db.settings.targetId === 'xunn') db.settings.targetId = '';
    db.blocked = (db.blocked || []).filter(x => x !== 'shenmz' && x !== 'xunn');
    ['shenmz', 'xunn'].forEach(k => {
      if (db.remarks) delete db.remarks[k];
      if (db.lastCard) delete db.lastCard[k];
      if (db.mood) delete db.mood[k];
    });
    db._v20noPreset = true;
  }
  // v5 小手机体验字段（phone.js 的 migrate 也会兜底）
  if (!db.lock || typeof db.lock !== 'object') db.lock = { enabled: true, password: '12345' };
  if (!db.skin) db.skin = 'pink';
  if (!db.remarks || typeof db.remarks !== 'object') db.remarks = {};
  if (!Array.isArray(db.blocked)) db.blocked = [];
  if (!db.lastCard || typeof db.lastCard !== 'object') db.lastCard = {};
  save();
  applyTheme();
}
function applyTheme() {
  // 默认深色 North 风；db.dark=false 时切换到浅色
  document.body.classList.toggle('light', !db.dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', db.dark ? '#000000' : '#ededed');
}

/* ---------------- 角色内心状态条 ---------------- */
const MOOD_BANK = {
  shenmz: [
    '刚忙完手头的事，顺手看了眼你那边的动静。', '在沙发上半躺着，想你这会儿在干嘛。',
    '泡了杯茶，水还烫，先等着。', '有点不放心，你别又熬太晚。', '在看书，余光一直瞟着手机，有点期待。'
  ],
  xunn: [
    '刚敷完面膜，满脑子都是你的瓜！', '在追剧，看到男二就想起你上次说的事。',
    '刷到个搞笑视频，手指已经悬在转发键上了。', '瘫在床上刷手机，随时待命听你吐槽。', '奶茶点了一半，等你消息等得有点无聊。'
  ]
};
function moodFor(charId) {
  const bank = MOOD_BANK[charId] || ['在做自己的事，偶尔想起你，有点在意。', '心情还行，就是好奇你什么时候开口。'];
  return bank[Math.floor(Math.random() * bank.length)];
}
function updateMood(charId, elId, force = false) {
  const m = db.mood[charId];
  const now = Date.now();
  let text;
  if (!force && m && now - m.ts < 120000) { text = m.text; }
  else { text = moodFor(charId); db.mood[charId] = { text, ts: now }; save(); }
  const el = document.getElementById(elId);
  if (el) el.textContent = text;
}

/* ---------------- 多身份 ---------------- */
function curIdent() { return db.identities.find(i => i.id === db.curIdent) || db.identities[0]; }
function renderIdentities() {
  const list = db.identities.map(i => `
    <div class="ident-row ${i.id === db.curIdent ? 'on' : ''}" data-act="switch-ident" data-id="${i.id}">
      <img src="${i.avatar || svgMe()}" style="width:40px;height:40px;border-radius:50%;object-fit:cover">
      <div style="flex:1"><div style="font-weight:600;font-size:15px">${esc(i.name)}</div><div style="font-size:11px;color:#999">微信号：${esc(i.wcid)}</div></div>
      ${i.id === db.curIdent ? '<span style="color:#07c160">当前</span>' : '<span class="arrow">›</span>'}
    </div>`).join('');
  openSheet(`<div class="sheet-head"><b>切换微信号</b><button data-act="close-sheet">关闭</button></div>
    <div class="sheet-body">
      ${list}
      <button class="wiz-btn ghost" data-act="add-ident">+ 新建一个微信号</button>
    </div>`);
}
function addIdentitySheet() {
  openSheet(`<div class="sheet-head"><b>新建微信号</b><button data-act="close-sheet">关闭</button></div>
    <div class="sheet-body">
      <div class="wiz-label">昵称</div>
      <input class="wiz-input" id="identName" placeholder="给自己起个名字">
      <div class="wiz-label">微信号</div>
      <input class="wiz-input" id="identWcid" placeholder="wx_xxx">
      <button class="wiz-btn" id="identOk">创建</button>
    </div>`);
  $('#identOk').onclick = () => {
    const name = $('#identName').value.trim() || '我';
    const wcid = $('#identWcid').value.trim() || ('wx_' + Math.random().toString(36).slice(2, 8));
    db.identities.push({ id: 'id_' + uid(), name, avatar: '', wcid });
    save();
    closeSheet();
    toast('已新建身份，可在列表切换');
  };
}

/* ---------------- 心动审判 ---------------- */
const TRIAL_QS = [
  { q: 'TA 偷偷在你杯子里下了药，想让你一直留在身边。你醒来后会？', a: ['哭着质问但最终接受', '假装不知道继续喝', '倒掉药，说愿意替 TA 生根本不用骗'] },
  { q: 'TA 把你所有异性朋友都拉黑了，还要求你手机随时定位。你？', a: ['默默接受，反正只爱 TA', '生气大吵一架', '表面答应，偷偷留了后手'] },
  { q: 'TA 说"你只能看着我一个人"，把你关在房间里三天。你？', a: ['享受这份独占', '绝食逼 TA 开门', '假装顺从，找机会逃'] },
  { q: '你发现 TA 的地下室里全是你的照片和用过的东西。你？', a: ['感动，TA 真的很爱我', '害怕，偷偷报警', '走进去一件件看，问 TA 每一个的故事'] },
  { q: 'TA 用你的名义借了一大笔钱，说"我们永远绑在一起了"。你？', a: ['一起还，反正分不开了', '马上分手去报警', '问 TA 为什么不商量，然后一起还'] },
  { q: 'TA 在你脖子上留下了很深的印记，说这样别人就知道你是 TA 的。你？', a: ['很开心，戴上围巾都觉得甜', '愤怒，觉得不被尊重', '要求 TA 也留一个一样的'] },
  { q: '你意外得知 TA 为了接近你，接近了你身边所有人。你？', a: ['觉得 TA 太有魅力了', '感觉被算计，要离开', '问 TA 为什么不直接找我'] },
  { q: 'TA 说"如果你敢离开我，我就毁了你的一切"。你？', a: ['不会离开，永远', '害怕地妥协', '冷笑，说你试试看'] },
  { q: 'TA 让你在朋友和 TA 之间二选一。你？', a: ['当然选 TA', '都要，不选', '选朋友，但偷偷见 TA'] },
  { q: 'TA 把你最喜欢的东西摔碎了，说"你只需要喜欢我"。你？', a: ['道歉，说以后只看 TA', '哭着捡碎片', '平静地说，那你赔我'] },
  { q: 'TA 给你看了一段你睡着时录的视频。你？', a: ['害羞又心动', '觉得被侵犯', '问 TA 录了多少'] },
  { q: 'TA 让你辞掉工作，搬到 TA 家里住。你？', a: ['马上答应', '要考虑考虑', '拒绝，但天天去陪 TA'] },
  { q: 'TA 的前任来找你，说 TA 以前也这样对过 TA。你？', a: ['相信 TA 现在只爱我', '开始怀疑要离开', '找 TA 对峙，但最后选择相信'] },
  { q: 'TA 说"你身上每一寸都是我的"，要在你身上留永久印记。你？', a: ['同意，这是爱的证明', '坚决拒绝', '只同意在隐蔽的地方'] },
  { q: 'TA 突然消失了三天，回来后满身是血，说"没人能再分开我们了"。你？', a: ['抱着 TA 说辛苦了', '报警', '先包扎伤口，再慢慢问'] },
  { q: 'TA 把你们的合照设成了所有平台头像，还公开了你们的关系。你？', a: ['超开心', '觉得被逼迫', '要求 TA 也公开手机密码'] },
  { q: 'TA 要求你每天汇报行踪，精确到小时。你？', a: ['乖乖汇报', '嫌烦但照做', '反过来要 TA 也汇报'] },
  { q: 'TA 把你最喜欢的宠物送走了，说"你只需要爱我"。你？', a: ['原谅 TA，以后只养 TA', '崩溃大哭要分手', '找回来，但不告诉 TA'] },
  { q: 'TA 说"如果你死了，我也不活了"。你？', a: ['承诺永远不离开', '觉得太沉重', '开玩笑说那我们一起'] },
  { q: 'TA 在你手机里装了监控软件，你发现了。你？', a: ['不拆穿，假装不知道', '当面删掉', '也给 TA 装一个'] },
  { q: 'TA 不允许你穿暴露的衣服，甚至不让你照镜子太久。你？', a: ['都听 TA 的', '觉得控制欲太强', '问 TA 是不是不放心我'] },
  { q: 'TA 把你锁在车里，开到了一个没人的地方。你？', a: ['问 TA 要带我去哪', '恐慌想逃', '安静等着看 TA 想干嘛'] },
  { q: 'TA 说"你是我在这世上唯一的光"，然后哭了。你？', a: ['抱紧 TA 说我也是', '心疼但有点害怕', '问 TA 发生了什么'] },
  { q: 'TA 让你写一封遗书，说"万一我们出事了"。你？', a: ['认真写了', '拒绝，觉得不吉利', '写了，但藏起来没给 TA'] },
  { q: 'TA 把你介绍给 TA 家人时，说你是"我的人"。你？', a: ['害羞点头', '觉得不舒服', '笑着说是"我们的人"'] },
  { q: 'TA 凌晨三点打电话说"我想你想得睡不着"。你？', a: ['立刻打车过去', '哄 TA 睡觉', '开视频陪 TA 到天亮'] },
  { q: 'TA 在你包里放了定位器，你发现了。你？', a: ['放回去，让 TA 安心', '扔掉质问', '自己也带一个'] },
  { q: 'TA 说"我为你杀过人"。你？', a: ['说我也是，吓了一跳又笑', '报警', '问 TA 是不是为了我'] },
  { q: 'TA 让你在 TA 面前跪下，说这样才证明爱。你？', a: ['跪了', '转身就走', '问 TA 是不是在测试我'] },
  { q: '最后一题：你愿意和 TA 一起沉沦吗？', a: ['我愿意', '我害怕但我离不开', '让我再想想'] }
];
const TRIAL_DIMS = ['默契', '占有', '沉沦', '反抗', '危险'];
function scoreAnswer(qIdx, optIdx) {
  // 每个选项对5个维度贡献不同
  const map = [
    [[40,40,60,10,20],[20,60,40,30,50],[50,30,50,20,30]],
    [[30,50,40,20,30],[10,20,30,70,10],[40,40,30,30,40]],
    [[50,50,70,5,15],[5,10,15,85,5],[30,30,40,50,20]],
    [[40,60,60,15,25],[10,15,20,80,5],[45,45,50,20,35]],
    [[45,50,55,20,25],[5,15,10,85,5],[50,40,50,25,30]],
    [[55,60,65,10,20],[5,10,10,90,5],[40,40,45,30,30]],
    [[35,45,40,30,25],[10,15,20,75,15],[50,35,45,25,30]],
    [[30,70,60,10,30],[10,15,20,80,10],[40,40,40,30,20]],
    [[40,65,55,15,25],[30,20,25,60,10],[35,40,40,35,15]],
    [[35,60,50,20,20],[5,10,15,90,5],[45,35,45,30,25]],
    [[40,55,55,20,30],[10,20,25,75,15],[45,40,50,25,35]],
    [[50,60,55,15,20],[30,30,30,50,15],[40,40,40,30,25]],
    [[40,50,45,30,25],[10,15,20,80,10],[50,40,50,20,30]],
    [[45,70,65,10,25],[5,10,10,90,10],[40,45,50,25,20]],
    [[40,60,55,15,30],[5,15,10,85,10],[50,40,45,20,25]],
    [[55,55,55,15,20],[15,20,25,70,15],[45,45,45,25,25]],
    [[50,60,50,20,20],[30,30,25,55,10],[40,40,40,30,20]],
    [[35,60,50,20,20],[5,10,15,90,10],[30,35,35,45,15]],
    [[50,70,70,5,20],[10,15,20,80,10],[40,50,55,20,25]],
    [[40,55,50,25,30],[5,15,20,80,10],[45,45,45,30,30]],
    [[50,55,50,20,20],[10,20,25,75,15],[40,40,40,30,20]],
    [[35,60,50,20,30],[10,15,20,80,10],[45,40,45,25,25]],
    [[40,55,55,20,25],[15,20,25,70,15],[45,40,50,25,20]],
    [[55,65,60,15,30],[5,15,15,85,10],[45,45,50,25,25]],
    [[45,55,50,25,20],[15,20,20,75,10],[40,40,40,30,20]],
    [[50,55,55,20,25],[30,25,30,55,10],[45,40,45,25,20]],
    [[45,60,50,20,25],[5,15,20,80,10],[40,45,45,30,25]],
    [[55,70,65,10,35],[5,15,15,85,15],[45,50,50,20,30]],
    [[40,70,60,15,25],[5,10,10,90,10],[45,45,50,20,20]],
    [[60,75,80,5,30],[10,20,25,75,20],[40,50,55,20,25]]
  ];
  return map[qIdx]?.[optIdx] || [0,0,0,0,0];
}
function trialEnding(dims) {
  const { 默契:m, 占有:p, 沉沦:s, 反抗:r, 危险:d } = dims;
  let title, desc;
  if (r > 55) { title = '清醒出逃者'; desc = '你始终保留着自己，这场游戏你看在眼里却没被吞没。'; }
  else if (m > 45 && s > 45) { title = '赤色共犯'; desc = '这不是一份温和的答案：你们把占有、挑衅和沉迷都推到了彼此面前。'; }
  else if (d > 45) { title = '深渊同行者'; desc = '你看见了深渊，然后跳了进去。TA 不会让你离开。'; }
  else if (p > 50) { title = '笼中的雀'; desc = '你自愿走进笼子，把钥匙交给了 TA。'; }
  else { title = '暧昧试探者'; desc = '你在爱与清醒之间摇摆，TA 还在等你做出选择。'; }
  return { title, desc };
}
let trialIdx = 0;
function openTrial() {
  trialIdx = 0;
  db.trial = { answers: [], dims: { 默契: 0, 占有: 0, 沉沦: 0, 反抗: 0, 危险: 0 } };
  save();
  $('#trialPage').classList.add('active');
  $('#trialPage').style.display = 'flex';
  renderTrial();
}
function renderTrial() {
  if (trialIdx >= TRIAL_QS.length) { renderTrialResult(); return; }
  const q = TRIAL_QS[trialIdx];
  $('#trialBody').innerHTML = `
    <div class="trial-progress">第 ${trialIdx + 1} / ${TRIAL_QS.length} 题
      <div class="trial-bar"><i style="width:${((trialIdx)/TRIAL_QS.length)*100}%"></i></div></div>
    <div class="trial-q">${esc(q.q)}</div>
    ${q.a.map((o, i) => `<button class="trial-opt" data-act="trial-opt" data-i="${i}">${String.fromCharCode(65+i)}. ${esc(o)}</button>`).join('')}
    <div style="text-align:center;color:#888;font-size:11px;padding:14px">选定后揭晓 TA 锁定的期待</div>`;
}
function renderTrialResult() {
  const d = db.trial.dims;
  const e = trialEnding(d);
  const bars = TRIAL_DIMS.map(k => `<div class="trial-dim"><span class="nm">${k}</span><div class="bar"><i style="width:${d[k]}%"></i></div><span class="pc">${d[k]}%</span></div>`).join('');
  $('#trialBody').innerHTML = `
    <div class="trial-result">
      <div style="text-align:center;font-size:12px;color:#888">30 题 · 你的回答与 TA 期待已揭晓</div>
      <div class="trial-title">${e.title}</div>
      <div class="trial-desc">${e.desc}</div>
      ${bars}
      <div class="trial-quote"><b>TA 留给你的话</b>三十个答案我都记下了，六道你选歪的，我会一道一道找你兑现。</div>
    </div>
    <div class="trial-btns">
      <button class="ghost" data-act="trial-hall">返回大厅</button>
      <button class="primary" data-act="trial-restart">换一份再测</button>
    </div>`;
}

/* ---------------- 路由 ---------------- */
let currentPage = 'chats';
let currentChat = null;
function showPage(name) {
  currentPage = name;
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
  $('#tabbar').style.display = 'flex';
  $$('.subpage').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
  if (name === 'chats') renderChats();
  if (name === 'contacts') renderContacts();
  if (name === 'rec') renderRecCenter();
  if (name === 'me') renderMe();
  if (name === 'moments' && window.VXMoments) VXMoments.render();
}
/* ---------------- 通讯录（好友申请 / 群聊 / 角色） ---------------- */
function renderContacts() {
  const wrap = $('#contactsWrap'); if (!wrap) return;
  const reqs = (db.friendReqs || []).filter(r => r.status === 'pending').length;
  const chars = (db.customs || []);
  wrap.innerHTML = `
    <div class="wx-group">
      <button class="wx-row" data-act="friend-reqs">
        <span class="wx-ic" style="background:linear-gradient(135deg,#ffa94d,#ff8f1f)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.9"><circle cx="12" cy="8" r="3.6"/><path d="M5.5 20.5c1-3.8 3.6-5.6 6.5-5.6s5.5 1.8 6.5 5.6"/></svg></span>新的朋友
        <span class="val">${reqs ? reqs + ' 个待处理' : '暂无申请'}</span>${reqs ? '<span class="dot"></span>' : ''}<span class="arrow">›</span>
      </button>
      <button class="wx-row" data-act="custom-shop">
        <span class="wx-ic">✨</span>定制专属角色<span class="val">免费试用 3 天</span><span class="arrow">›</span>
      </button>
      <button class="wx-row" data-act="open-groups">
        <span class="wx-ic">👥</span>群聊<span class="val">开发中</span><span class="arrow">›</span>
      </button>
    </div>
    <div class="wx-group">
      <div style="padding:10px 14px 4px;color:#8a8a8e;font-size:12px">我的好友（${chars.filter(c => c.friendStatus === 'accepted').length}）</div>
      ${chars.filter(c => c.friendStatus === 'accepted').map(c => `
        <button class="wx-row" data-act="open-custom" data-id="${c.id}">
          <img class="avatar" style="width:36px;height:36px;border-radius:6px" src="${c.avatar || (window.VXCustom ? VXCustom.svgLetter(c.name) : svgMe())}">
          <span style="flex:1;text-align:left">${esc(c.name)}</span><span class="arrow">›</span>
        </button>`).join('') || '<div style="padding:14px;color:#777;font-size:13px;text-align:center">还没有好友，去定制一个吧</div>'}
    </div>`;
}
function updateBadges() {
  /* 聊天角标 = 定制角色未读消息；通讯录角标 = 待处理好友申请（微信同款） */
  const chatUnread = (db.customs || []).reduce((s, c) => s + (c.unread || 0), 0);
  const reqs = (db.friendReqs || []).filter(r => r.status === 'pending').length;
  const b = $('#badge-chats');
  b.style.display = chatUnread ? 'flex' : 'none';
  b.textContent = chatUnread > 99 ? '99+' : chatUnread;
  const br = $('#badge-contacts');
  if (br) {
    br.style.display = reqs ? 'flex' : 'none';
    br.textContent = reqs > 99 ? '99+' : reqs;
  }
}
function renderGlobalState() {
  const el = $('#globalState');
  if (!el) return;
  if (Watcher.running) {
    el.innerHTML = `<i class="dot ${Watcher.busy ? 'busy' : 'on'}"></i>${Watcher.busy ? '识别中…' : '屏幕识别运行中'}`;
  } else {
    el.innerHTML = '<i class="dot off"></i>屏幕识别未开启';
  }
}

/* ---------------- 聊天 ---------------- */
function isBlocked(id) { return (db.blocked || []).includes(id); }
function displayName(id) { return (db.remarks && db.remarks[id]) || getChar(id)?.name || ''; }
function previewOf(list) {
  const m = list[list.length - 1];
  if (!m) return '';
  if (m.type === 'screen') return `[读屏] ${m.text}`;
  if (m.type === 'card') return `[卡片] ${String(m.text).split('\n')[0]}`;
  if (m.type === 'call') return `[通话] ${m.text}`;
  return m.text;
}
function renderChats() {
  bindChatListGestures();
  $('#chatList').innerHTML = '';
  if (window.VXCustom) VXCustom.mountChatList();
  const hasCustoms = (db.customs || []).some(c => c.friendStatus === 'accepted');
  if (!hasCustoms) {
    $('#chatList').insertAdjacentHTML('beforeend',
      `<div style="padding:52px 0;text-align:center;color:#9a9a9f;font-size:14px;line-height:2">还没有聊天<br><span style="font-size:12px;color:#777">点右上角 + 创建你的专属角色</span></div>`);
  }
  updateBadges();
  renderGlobalState();
}
/* 聊天列表删除（长按 600ms / 右划露删除键，桌面右键等效长按） */
function askDeleteChat(id) {
  const cu = (db.customs || []).find(c => c.id === id);
  const label = cu ? cu.name : (db.remarks && db.remarks[id]) || '该聊天';
  openSheet(`<div class="sheet-body" style="padding-top:16px">
    <h3 style="font-size:17px;margin-bottom:8px">删除聊天？</h3>
    <p style="font-size:13px;color:#777;line-height:1.7">将与「${esc(label)}」的聊天记录${cu ? '及该角色' : ''}一起删除，不可恢复。</p>
    <button class="wiz-btn" data-act="confirm-delete-chat" data-id="${id}">删除</button>
    <button class="wiz-btn ghost" data-act="close-sheet">取消</button></div>`);
}
function deleteChat(id) {
  const cu = (db.customs || []).find(c => c.id === id);
  if (cu) db.customs = db.customs.filter(c => c.id !== id);
  else { delete db.chats[id]; delete db.unread[id]; if (db.remarks) delete db.remarks[id]; }
  if (db.settings.targetId === id) db.settings.targetId = '';
  closeSheet(); save(); renderChats(); showPage('chats'); toast('已删除');
}
function bindChatListGestures() {
  const list = $('#chatList');
  if (!list || list.dataset.gest) return;
  list.dataset.gest = '1';
  let timer = null, sx = 0, sy = 0, row = null;
  const closeOpen = except => list.querySelectorAll('.chat-row.swipe-open')
    .forEach(r => { if (r !== except) r.classList.remove('swipe-open'); });
  list.addEventListener('touchstart', e => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    row = t.target.closest ? t.target.closest('.chat-row[data-id]') : null;
    closeOpen(row);
    if (!row) return;
    timer = setTimeout(() => { timer = null; if (navigator.vibrate) navigator.vibrate(30); askDeleteChat(row.dataset.id); }, 600);
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (timer && (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12)) { clearTimeout(timer); timer = null; }
    if (row && t.clientX - sx > 56) row.classList.add('swipe-open');
  }, { passive: true });
  list.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } row = null; });
  list.addEventListener('contextmenu', e => {
    const r = e.target.closest('.chat-row[data-id]');
    if (r) { e.preventDefault(); askDeleteChat(r.dataset.id); }
  });
  list.addEventListener('click', e => {
    const del = e.target.closest('.row-del');
    if (del) { e.stopPropagation(); deleteChat(del.closest('.chat-row').dataset.id); return; }
    if (e.target.closest('.chat-row.swipe-open')) { e.stopPropagation(); closeOpen(); }
  }, true);
}
function onChatSearch() { renderChats(); }
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'chatSearch') renderChats();
});
function openChat(id) {
  /* 预设角色已下线：定制角色走专属聊天房间 */
  const cu = (db.customs || []).find(c => c.id === id);
  if (cu) { if (window.VXCustom) VXCustom.openCustomChat(id); return; }
  const c = getChar(id);
  if (!c) { toast('该聊天已删除'); renderChats(); return; }
  currentChat = id;
  db.unread[id] = 0;
  updateBadges();
  $('#crName').textContent = (db.remarks && db.remarks[id]) || c.name;
  $('#typingAvatar').src = c.avatar;
  if (window.VXPhone) VXPhone.applySkin();
  $('#chatroom').classList.add('active');
  $('#chatroom').style.display = 'flex';
  $('#tabbar').style.display = 'none';
  renderMessages();
  updateMood(id, 'crMoodText');
}
/* 让 TA 主动回复一条（手动触发） */
function setReplyBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<i class="mr-spinner"></i><span class="mr-txt">回复中…</span>';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<svg class="mr-ic" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span class="mr-txt">让 TA 回复</span>';
  }
}
async function makeCharacterReply(c) {
  const btn = document.querySelector('[data-act="cr-make-reply"]');
  setReplyBtnLoading(btn, true);
  const msgs = db.chats[c.id] || [];
  const lastUser = [...msgs].reverse().find(m => m.from === 'me');
  const prompt = lastUser ? lastUser.text : '（主动找话题，按你的性格发2-3条消息）';
  const typing = document.getElementById('typingBar');
  typing.style.display = 'flex';
  const startAt = Date.now();
  try {
    const sys = buildSystemPrompt(c, 'chat');
    const hist = buildHistory(c);
    const raw = await callLLM(sys, [...hist, { role: 'user', content: prompt }], 0.95);
    const lines = raw ? splitBubbles(raw, c) : null;
    typing.style.display = 'none';
    if (lines && lines.length) {
      lines.forEach((l, idx) => setTimeout(() => {
        pushMessage(c.id, { id: uid(), from: 'them', type: 'text', text: l, ts: Date.now() });
        if (idx === lines.length - 1) updateMood(c.id, 'crMoodText', true);
      }, idx * 700));
      maybeSendCard(c, lastUser, lines.length * 700 + 600);
    } else {
      pushMessage(c.id, { id: uid(), from: 'them', type: 'text', text: c.bank[Math.floor(Math.random() * c.bank.length)], ts: Date.now() });
    }
  } catch (e) {
    typing.style.display = 'none';
    pushMessage(c.id, { id: uid(), from: 'them', type: 'text', text: c.bank[Math.floor(Math.random() * c.bank.length)], ts: Date.now() });
  }
  const elapsed = Date.now() - startAt;
  const wait = Math.max(0, 1500 - elapsed);
  if (btn) { setTimeout(() => setReplyBtnLoading(btn, false), wait); }
}
/* 星空浪漫卡片：低频触发（用户说情话时高概率） */
async function maybeSendCard(c, lastUser, delayMs) {
  if (!lastUser) return;
  const last = db.lastCard[c.id] || 0;
  if (Date.now() - last < 30 * 60 * 1000) return;
  const romantic = /喜欢|爱你|想你|情话|告白|在一起/.test(lastUser.text);
  if (!romantic && Math.random() > 0.12) return;
  let card = null;
  if (db.settings.deepseekKey) {
    try {
      const raw = await callLLM(
        buildSystemPrompt(c, 'chat'),
        [{ role: 'user', content: `（写一张送给用户的浪漫小卡片。格式严格三行：第一行短句/第二行短句/——你的名字。诗意克制、符合你的性格，不要多余文字）` }],
        0.85
      );
      const lines = raw ? raw.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
      if (lines.length >= 2) {
        const sign = (lines.find(l => l.startsWith('——')) || `——${c.name}`).replace(/^——/, '');
        const body = lines.filter(l => !l.startsWith('——')).slice(0, 2);
        card = `${body[0] || ''}\n${body[1] || ''}\n${sign || c.name}`;
      }
    } catch (e) { card = null; }
  }
  if (!card) {
    const bank = {
      shenmz: '有些话\n只想让你看见\n——沈慕朝',
      xunn: '偷偷告诉你\n你比瓜重要\n——念念'
    };
    card = bank[c.id] || `有些话\n只想让你看见\n——${c.name}`;
  }
  db.lastCard[c.id] = Date.now();
  save();
  setTimeout(() => {
    pushMessage(c.id, { id: uid(), from: 'them', type: 'card', text: card, ts: Date.now() });
    updateMood(c.id, 'crMoodText', true);
  }, delayMs || 1500);
}
function renderMessages() {
  const list = db.chats[currentChat] || [];
  const c = getChar(currentChat);
  let html = '', lastDay = '';
  list.forEach(m => {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="time-msg">${fmtHM(m.ts)}</div>`; lastDay = day; }
    if (m.type === 'sys') return (html += `<div class="sys-msg"><span><i class="sys-check">✓</i>${esc(m.text)}</span></div>`);
    if (m.type === 'card') {
      const lines3 = String(m.text).split('\n');
      return (html += `<div class="msg"><img class="avatar" src="${c.avatar}"><div><div class="card-msg">
        <div class="cm-star">✦</div>
        <div class="cm-l1">${esc(lines3[0] || '')}</div>
        <div class="cm-l2">${esc(lines3[1] || '')}</div>
        <div class="cm-sign">——${esc((lines3[2] || c.name).replace(/^——/, ''))}</div>
      </div><div class="msg-time">${fmtHM(m.ts)}</div></div></div>`);
    }
    const mine = m.from === 'me';
    const av = mine ? ((db.profile && db.profile.avatar) || svgMe()) : c.avatar;
    let body;
    if (m.type === 'screen') {
      body = `<div class="evi-bubble">
        <img class="evi-thumb" src="${m.thumb}" data-act="preview-img" data-src="${m.thumb}">
        <div class="evi-body">
          <span class="evi-tag">👁 已读屏 · ${esc(m.topic || '其他')}${m.engine === 'vision' ? ' · 视觉模型' : ' · 本地OCR'}</span>
          <div class="evi-text">${esc(m.text)}</div>
          ${m.excerpt ? `<div class="evi-excerpt">识别内容：${esc(m.excerpt)}</div>` : ''}
          <div class="evi-meta"><span>${fmtHM(m.ts)}</span></div>
        </div></div>`;
    } else if (m.type === 'voice') {
      /* 唱歌/语音消息：波形气泡 + 时长，点击播放 */
      body = `<div class="bubble voice-msg" data-act="play-voice" data-mid="${m.id}">
          <span class="vw"><i></i><i></i><i></i><i></i></span>
          <span class="vd">${m.dur || 6}"</span>
        </div><div class="msg-time">${fmtHM(m.ts)}</div>`;
    } else if (m.type === 'song') {
      /* ♪ 歌曲卡片：与唱歌语音成对下发（视频03同款） */
      body = `<div class="song-card" data-act="play-song" data-mid="${m.id}">
          <span class="sc-note">♪</span><span class="sc-name">${esc(m.text)}</span><span class="sc-play">▶</span>
        </div><div class="msg-time">${fmtHM(m.ts)}</div>`;
    } else {
      body = `<div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>
              <div class="msg-time">${fmtHM(m.ts)}</div>`;
    }
    html += `<div class="msg ${mine ? 'me' : ''}"><img class="avatar" src="${av}">${body}</div>`;
  });
  $('#crScroll').innerHTML = html;
  const sc = $('#crScroll');
  sc.scrollTop = sc.scrollHeight;
}
function svgMe() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' rx='14' fill='#7ba7c9'/><text x='50%' y='56%' font-size='40' text-anchor='middle' fill='white' font-family='sans-serif' dominant-baseline='middle'>我</text></svg>");
}
function pushMessage(chatId, msg) {
  if (!db.chats[chatId]) db.chats[chatId] = [];
  db.chats[chatId].push(msg);
  save();
  if (currentChat === chatId && $('#chatroom').classList.contains('active')) renderMessages();
  else { db.unread[chatId] = (db.unread[chatId] || 0) + 1; updateBadges(); }
  if (currentPage === 'chats') renderChats();
}
/* =========================================================
 * 点歌系统（模仿 North小手机 视频03「耳朵好舒服」）
 * 用户点歌 → 人设三连回应 → 唱歌语音(波形动画) → ♪歌曲卡片
 * ========================================================= */
function detectSong(text) {
  const t = String(text).trim();
  let m = t.match(/(?:想听你唱|想听你亲口唱|唱一?首|来一?首|点(?:一)?首(?:歌)?|点歌)\s*(?:《|「)?([^\s《》」!！?？。.,，~]{1,24})(?:》|」)?/);
  if (m && m[1] && !/怎么|吗$|什么|解释/.test(m[1])) return m[1];
  m = t.match(/我想听(?:你唱)?\s*(?:《|「)([^\s《》」]{1,24})(?:》|」)/);
  if (m && m[1]) return m[1];
  return null;
}
async function songRequestFlow(c, chatId, song, seq) {
  showTyping(true);
  try {
    const sys = buildSystemPrompt(c, 'chat');
    let lines = null;
    if (db.settings.deepseekKey) {
      try {
        const raw = await callLLM(sys, [{ role: 'user', content: `（用户点歌：想听你唱《${song}》。请按你的性格回应，共3条消息、每条一行、每条不超过25字：第1条短应一声或调侃被点名，第2条假装忙/傲娇一下，第3条答应唱。不要写歌词，不要多余内容）` }], 0.9);
        lines = raw ? splitBubbles(raw, c) : null;
      } catch (e) { lines = null; }
    }
    if (!lines || !lines.length) lines = [`唱《${song}》？`, `行吧，就宠你。`, `听好了。`];
    for (let i = 0; i < lines.length; i++) {
      showTyping(true);
      await sleep(i === 0 ? rnd(400, 900) : rnd(700, 1400));
      if (seq !== replyState.seq) return;
      showTyping(false);
      pushMessage(chatId, { id: uid(), from: 'them', type: 'text', text: lines[i], ts: Date.now() });
    }
    /* 生成简短哼唱歌词 */
    let lyrics = '';
    if (db.settings.deepseekKey) {
      try {
        const raw2 = await callLLM(sys, [{ role: 'user', content: `（你要给用户清唱《${song}》。写3行简短的原创哼唱歌词，温柔口语有点甜，每行不超过12字，直接输出歌词本身，不要书名号不要解释）` }], 0.95);
        lyrics = (raw2 || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 3).join('\n');
      } catch (e) { }
    }
    if (!lyrics) lyrics = `♪ ${song} ♪\n♪ 啦啦啦 想你呀 ♪\n♪ 只唱给你一个人 ♪`;
    showTyping(true);
    await sleep(rnd(1200, 2200));
    if (seq !== replyState.seq) return;
    showTyping(false);
    const dur = 12 + Math.floor(Math.random() * 36); /* 12"~47" 随机时长 */
    pushMessage(chatId, { id: uid(), from: 'them', type: 'voice', text: lyrics, song, dur, ts: Date.now() });
    await sleep(rnd(700, 1500));
    if (seq !== replyState.seq) return;
    pushMessage(chatId, { id: uid(), from: 'them', type: 'song', text: song, ts: Date.now() });
    updateMood(chatId, 'crMoodText', true);
  } catch (e) { showTyping(false); }
}
/* 播放语音/唱歌消息：波形动画 + TTS 哼唱 */
function playVoiceMsg(mid) {
  const m = (db.chats[currentChat] || []).find(x => x.id === mid);
  if (!m) return;
  document.querySelectorAll('.voice-msg.playing').forEach(x => x.classList.remove('playing'));
  const elb = document.querySelector(`.voice-msg[data-mid="${mid}"]`);
  try { speechSynthesis.cancel(); } catch (e) { }
  if (elb) elb.classList.add('playing');
  const u = new SpeechSynthesisUtterance(m.text || ('♪ ' + (m.song || '') + ' ♪'));
  u.lang = 'zh-CN'; u.rate = 0.82; u.pitch = 1.12;
  const c = getChar(currentChat);
  const vs = speechSynthesis.getVoices();
  const pick = vs.find(v => (c && c.voice === 'deep_m') ? /male|男/i.test(v.name) : /female|女/i.test(v.name));
  if (pick) u.voice = pick;
  const done = () => { if (elb) elb.classList.remove('playing'); };
  u.onend = done; u.onerror = done;
  speechSynthesis.speak(u);
}
/* 点击歌曲卡片：找到同名的唱歌语音并播放 */
function playSongCard(mid) {
  const list = db.chats[currentChat] || [];
  const card = list.find(x => x.id === mid);
  if (!card) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'voice' && list[i].song === card.text) return playVoiceMsg(list[i].id);
  }
  toast('♪ ' + card.text);
}
/* =========================================================
 * 真人聊天引擎
 * 方案借鉴 GitHub 开源项目：
 *  - SillyTavern 角色卡：personality/scenario + 示例对话 few-shot 教语气
 *  - chatgpt-on-wechat：character_desc 人格 + 多轮上下文窗口 + temperature
 * ========================================================= */
const LLM_URL = 'https://api.deepseek.com/chat/completions';
const LLM_MODEL = 'deepseek-chat';
const LLM_TIMEOUT = 15000;
const replyState = { seq: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

/* 角色卡 → 系统提示词 */
function buildSystemPrompt(c, mode, ctx = {}) {
  let p = `你是${c.name}，用户的${c.role}，现在正用微信和用户私聊。当前时间${fmtHM(Date.now())}。\n\n`
    + `【关系背景】${c.background || c.desc}\n`
    + `【性格】${c.personality || c.desc}\n`
    + `【说话风格】${c.style || '自然口语'}\n`;
  if (c.habits?.length) p += `【语言习惯】${c.habits.join('；')}\n`;
  if (c.emoji) p += `【表情规则】${c.emoji}\n`;
  p += `\n【真人聊天铁律】
1. 像真人发微信：口语化、短句为主，单条尽量不超过${c.maxLen || 30}字，长句拆短，可以省略主语，句子不完整也没关系；
2. 严禁AI腔：不许出现"作为AI/语言模型、我无法、希望可以帮到你、综上所述、总而言之、首先其次"之类的话，不用markdown、序号、列表、加粗、标题；
3. 多用日常语气词（啊/呀/嘛/呢/吧/哈/哦/哎），要有自己的态度和情绪，会吐槽、会反问、会主动抛话题，不要一味附和；
4. 不知道就说不知道，不编造事实，不替用户做重大决定；
5. 需要分多条消息发时，每条消息单独占一行（换行分隔），最多3条；不要加序号、引号或"消息1"之类的标记；
6. 只输出要发的消息内容本身，不要写解释，也不要带"${c.name}："这种前缀。\n`;
  if (mode === 'screen') {
    p += `\n【当前场景】用户正在看手机，你通过屏幕识别知道了 TA 正在看的内容。请主动发消息搭话，1~2条、每条不超过25字，紧扣看到的内容，别复述系统说明，也别编造屏幕里没有的细节。\n`;
  } else if (mode === 'scheduled') {
    p += `\n【当前场景】这是你主动发起的${ctx.win === 'noon' ? '午间' : '晚间'}问候，${ctx.win === 'noon' ? '问问吃饭、提醒起来活动' : '聊聊今天过得怎样、催 TA 别熬太晚'}，1~2条短消息，像顺手发的，别刻意。\n`;
  }
  if (c.examples?.length) {
    p += '\n【说话示例，学习这种语气和长度】\n';
    c.examples.forEach(ex => { p += `用户：${ex.u}\n${c.name}：${ex.a.join('\n')}\n`; });
  }
  return p;
}

/* 多轮上下文：读屏消息也作为角色说过的话带入，按总字数截断（参考 conversation_max_tokens） */
function buildHistory(c, maxChars = 1800) {
  const raw = (db.chats[c.id] || []).filter(m => m.type !== 'sys');
  const out = [];
  let used = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const content = String(raw[i].text || '').slice(0, 300);
    if (!content) continue;
    used += content.length;
    if (used > maxChars) break;
    out.unshift({ role: raw[i].from === 'me' ? 'user' : 'assistant', content });
  }
  return out;
}

/* 统一 LLM 调用层 */
async function callLLM(system, messages, temperature = 0.9, timeout = LLM_TIMEOUT) {
  if (!db.settings.deepseekKey) {
    /* 无 Key 时给一次明确引导（60 秒节流），避免静默回落让人摸不着头脑 */
    if (!callLLM._hintAt || Date.now() - callLLM._hintAt > 60000) {
      callLLM._hintAt = Date.now();
      toast('未配置 DeepSeek Key：到「我的 → DeepSeek 文案生成」填入你自己的 Key（填一次即可）', 4000);
    }
    throw new Error('no-key');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${db.settings.deepseekKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature,
        frequency_penalty: 0.6,
        presence_penalty: 0.3,
        stream: false
      })
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty');
    return text;
  } finally { clearTimeout(timer); }
}

/* 清洗模型输出：去角色名前缀、markdown 痕迹、包裹引号 */
function cleanLLMText(raw, c) {
  const labelRe = new RegExp('^(?:' + c.name + '|' + c.role + '|assistant|助手|AI)\\s*[:：]\\s*', 'i');
  const lines = String(raw).split(/\n+/).map(line => line
    .replace(labelRe, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/, '')
    .trim()).filter(Boolean);
  let t = lines.join('\n');
  t = t.replace(/^[「“"'‘]+|[」”"'’]+$/g, '').trim();
  return t;
}

/* 拆成多条微信气泡：换行拆；单条过长再按句读拆，最多3条 */
function splitBubbles(raw, c) {
  const text = cleanLLMText(raw, c);
  let parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const limit = c.maxLen || 30;
  if (parts.length === 1 && parts[0].length > limit + 12) {
    const sentences = parts[0].match(/[^。！？!?；;]+[。！？!?；;]?/g) || parts;
    parts = [];
    let buf = '';
    for (const s of sentences) {
      if (buf && (buf + s).length > limit) { parts.push(buf); buf = s; }
      else buf += s;
    }
    if (buf) parts.push(buf);
  }
  return parts.slice(0, 3).filter(Boolean);
}

/* 生成回复气泡数组，mode: chat / screen / scheduled */
async function generateReply(c, mode, ctx = {}) {
  const system = buildSystemPrompt(c, mode, ctx);
  let messages;
  if (mode === 'chat') {
    messages = buildHistory(c);
  } else if (mode === 'screen') {
    messages = [
      ...buildHistory(c, 600).slice(-4),
      { role: 'user', content: `屏幕话题：${ctx.topic}\n识别到的文字：${String(ctx.excerpt || '').slice(0, 400)}` }
    ];
  } else {
    messages = [{ role: 'user', content: ctx.win === 'noon' ? '到饭点了，你主动找用户说句话' : '晚上了，你主动关心一下用户' }];
  }
  const raw = await callLLM(system, messages, mode === 'chat' ? 0.95 : 0.9);
  const bubbles = splitBubbles(raw, c);
  if (!bubbles.length) throw new Error('empty-bubbles');
  return bubbles;
}

/* 正在输入指示器（仅在当前聊天房间可见时操作） */
function showTyping(show) {
  if (currentChat && $('#chatroom').classList.contains('active')) {
    $('#typingBar').style.display = show ? 'flex' : 'none';
  }
}

/* 真人节奏投递：逐条气泡 + 气泡间隔重新"正在输入" */
async function deliverBubbles(chatId, bubbles, seq) {
  for (let i = 0; i < bubbles.length; i++) {
    if (seq !== replyState.seq) return;
    const wait = i === 0
      ? rnd(450, 1000)
      : rnd(600, 1400) + Math.min(bubbles[i].length * 55, 1500);
    showTyping(true);
    await sleep(wait);
    if (seq !== replyState.seq) return;
    showTyping(false);
    pushMessage(chatId, { id: uid(), from: 'them', type: 'text', text: bubbles[i], ts: Date.now() });
  }
  // 每条回复结束后刷新一次角色心情
  if (currentChat === chatId) updateMood(chatId, 'crMoodText', true);
}

async function sendText() {
  const input = $('#msgInput');
  const text = input.value.trim();
  if (!text || !currentChat) return;
  input.value = '';
  const chatId = currentChat;
  pushMessage(chatId, { id: uid(), from: 'me', type: 'text', text, ts: Date.now() });
  if (isBlocked(chatId)) {
    setTimeout(() => {
      pushMessage(chatId, { id: uid(), from: null, type: 'sys', text: '消息已发出，但对方被你拉黑了', ts: Date.now() });
    }, 500);
    return;
  }
  const c = getChar(chatId);
  const seq = ++replyState.seq;
  /* 点歌检测：优先走点歌流程（视频03同款） */
  const songReq = detectSong(text);
  if (songReq) { songRequestFlow(c, chatId, songReq, seq); return; }
  /* 读完消息再开始输入：字数越多"看"得越久 */
  const readDelay = Math.min(500 + text.length * 45, 2400) + rnd(200, 700);
  showTyping(true);
  await sleep(readDelay);
  let bubbles = null;
  if (db.settings.deepseekKey) {
    try { bubbles = await generateReply(c, 'chat'); } catch (e) { bubbles = null; }
  }
  if (!bubbles || !bubbles.length) bubbles = localReplyBubbles(c, text);
  if (seq !== replyState.seq) return;       // 用户又发了新消息，旧回复作废
  await deliverBubbles(chatId, bubbles, seq);
  showTyping(false);
}

/* 本地兜底（无 Key 或接口失败）：关键词命中 + 不重复上一句 + 概率追问第二条 */
function localReplyBubbles(c, text) {
  let main = '';
  for (const [reg, arr] of c.keywords || []) {
    if (reg.test(text)) { main = arr[Math.floor(Math.random() * arr.length)]; break; }
  }
  if (!main) {
    const lastThem = (db.chats[c.id] || []).filter(m => m.from === 'them').slice(-1)[0];
    const pool = c.bank.filter(s => !lastThem || lastThem.text !== s);
    const use = pool.length ? pool : c.bank;
    main = use[Math.floor(Math.random() * use.length)];
  }
  const bubbles = [main];
  if (Math.random() < 0.45 && c.asks?.length) {
    bubbles.push(c.asks[Math.floor(Math.random() * c.asks.length)]);
  }
  return bubbles;
}

/* =========================================================
 * 核心 1：屏幕采集 + 感知哈希去重
 * ========================================================= */
const HAMMING_THRESHOLD = { high: 6, mid: 12, low: 20 };
const Watcher = {
  running: false, busy: false,
  stream: null, timer: null, worker: null,
  lastHash: null, lastPushAt: 0, lastTopicAt: {}, lastExcerpt: '',
  statusText: ''
};

async function startWatching() {
  toast('正在请求屏幕共享权限…', 1500);
  const isSecure = window.isSecureContext;
  if (!isSecure) {
    toast('需在 https 或 localhost 下才能共享屏幕', 4000);
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('当前浏览器不支持屏幕共享，请使用下方「手机截图识别」上传截图', 4000);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
  } catch (e) {
    toast('你取消了屏幕共享，已保持关闭', 3000);
    return;
  }
  Watcher.stream = stream;
  Watcher.running = true;
  Watcher.lastHash = null;
  const video = $('#screenVideo');
  video.srcObject = stream;
  Watcher.video = video;
  // 用户点浏览器自带的“停止共享”
  stream.getVideoTracks()[0].addEventListener('ended', () => stopWatching('屏幕共享已被系统停止'));
  toast('屏幕识别已开启，画面变化时会主动发消息');
  renderGlobalState();
  renderRecCenter();
  scheduleTick(800);
}
function stopWatching(reason) {
  if (!Watcher.running && !Watcher.stream) return;
  Watcher.running = false;
  clearTimeout(Watcher.timer);
  Watcher.timer = null;
  if (Watcher.stream) { Watcher.stream.getTracks().forEach(t => t.stop()); Watcher.stream = null; }
  $('#screenVideo').srcObject = null;
  renderGlobalState();
  renderRecCenter();
  if (reason) toast(reason);
}
function scheduleTick(delay) {
  clearTimeout(Watcher.timer);
  Watcher.timer = setTimeout(tick, delay ?? db.settings.intervalSec * 1000);
}

/* 抓帧：大图供识别，小图做证据缩略图 */
function grabFrame() {
  const v = Watcher.video;
  if (!v || !v.videoWidth) return null;
  const maxW = 1100;
  const scale = Math.min(1, maxW / v.videoWidth);
  const w = Math.max(2, Math.round(v.videoWidth * scale));
  const h = Math.max(2, Math.round(v.videoHeight * scale));
  const c = $('#grabCanvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  const full = c.toDataURL('image/jpeg', 0.72);
  const tw = 320, th = Math.max(2, Math.round(h * (320 / w)));
  const tc = document.createElement('canvas');
  tc.width = tw; tc.height = th;
  tc.getContext('2d').drawImage(c, 0, 0, tw, th);
  const thumb = tc.toDataURL('image/jpeg', 0.6);
  return { full, thumb };
}

/* 平均感知哈希 aHash（16×16 灰度 → 均值二值化 → 256bit） */
function aHash() {
  const v = Watcher.video;
  const c = $('#hashCanvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  const gray = [];
  for (let i = 0; i < d.length; i += 4) gray.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  const avg = gray.reduce((a, b) => a + b, 0) / gray.length;
  let hex = '';
  for (let i = 0; i < 16; i++) {
    let byte = 0;
    for (let j = 0; j < 16; j++) byte = (byte << 1) | (gray[i * 16 + j] >= avg ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

/* 一次完整采样 */
async function tick() {
  if (!Watcher.running) return;
  try {
    if (Watcher.busy) return scheduleTick();      // 上一帧还在识别，跳过本轮
    if (!Watcher.video || !Watcher.video.videoWidth) return scheduleTick();  // 视频流尚未就绪
    const hash = aHash();
    const threshold = HAMMING_THRESHOLD[db.settings.sensitivity] || 12;
    if (Watcher.lastHash) {
      const dist = hamming(Watcher.lastHash, hash);
      if (dist < threshold) {
        db.stats.skipped++;
        if (dist === 0) {
          Watcher.stillCount = (Watcher.stillCount || 0) + 1;
          if (Watcher.stillCount === 3) {
            toast('共享的画面没变化，请确认共享了正确的窗口（不要共享后台标签页）', 4000);
          }
          Watcher.statusText = '画面静止中（差异 0），请确认共享窗口在动';
        } else {
          Watcher.stillCount = 0;
          Watcher.statusText = `画面几乎没变化（差异 ${dist} < ${threshold}）`;
        }
        addLog({ action: 'skip', reason: `画面几乎没变化（差异 ${dist} < ${threshold}）`, thumb: null, ts: Date.now() });
        save(); renderRecCenter();
        return scheduleTick();
      }
      Watcher.stillCount = 0;
      Watcher.lastDist = dist;
    }
    Watcher.lastHash = hash;
    const frame = grabFrame();
    if (!frame) return scheduleTick();
    db.stats.frames++;
    Watcher.busy = true;
    renderGlobalState();

    await processFrame(frame);
  } catch (err) {
    const msg = err.message || String(err);
    Watcher.statusText = msg;
    addLog({ action: 'skip', reason: '识别异常：' + msg, thumb: null, ts: Date.now() });
    save();
  } finally {
    Watcher.busy = false;
    renderGlobalState();
    scheduleTick();
  }
}

/* 识别一帧 → 冷却去重 → 生成并推送主动消息（屏幕共享 tick 与手机截图上传共用） */
async function processFrame(frame, manual) {
  const result = await recognize(frame);          // {engine, text, summary, topic}
  const excerpt = (result.text || result.summary || '').trim();
  let topic = result.topic || classifyTopic(excerpt);
  Watcher.statusText = excerpt ? `识别到：${excerpt.slice(0, 30)}` : '画面变化，未识别到文字';

  // 内容过短（如刷视频时 OCR 几乎识别不到字）→ 仍推送一条通用话术，不让用户觉得没反应
  if (excerpt.length < 2) topic = '视频娱乐';
  // 冷却去重（手动上传截图时不拦截，用户明确想让 TA 看到）
  const now = Date.now();
  const inCooldown = now - Watcher.lastPushAt < db.settings.cooldownSec * 1000;
  const topicCooldown = now - (Watcher.lastTopicAt[topic] || 0) < db.settings.cooldownSec * 1000;
  if (!manual && (inCooldown || topicCooldown)) {
    db.stats.skipped++;
    Watcher.statusText = inCooldown ? `冷却中（${db.settings.cooldownSec}秒/条）` : '同话题去重';
    addLog({ action: 'skip', reason: inCooldown ? `主动消息冷却中（${db.settings.cooldownSec}秒/条）` : '同话题刚推送过，去重拦截', thumb: frame.thumb, excerpt, topic, engine: result.engine, ts: Date.now() });
    save(); renderRecCenter();
    return;
  }
  // 生成主动消息（目标：已添加的定制角色）
  const cu = (db.customs || []).find(x => x.id === db.settings.targetId && x.friendStatus === 'accepted')
    || (db.customs || []).find(x => x.friendStatus === 'accepted');
  if (!cu) { Watcher.statusText = '先创建并添加一个角色'; save(); renderRecCenter(); return; }
  let text = null;
  if (db.settings.deepseekKey) {
    try { text = await customScreenText(cu, topic, excerpt); } catch (e) { text = null; }
  }
  if (!text) text = ['在看这个呢？', '刷到什么好玩的？', '看久了歇歇眼睛。', '这个我有印象，说说？'][Math.floor(Math.random() * 4)];

  Watcher.lastPushAt = now;
  Watcher.lastTopicAt[topic] = now;
  Watcher.lastExcerpt = excerpt;
  db.stats.pushed++;
  const msg = { id: uid(), from: 'them', type: 'screen', text, thumb: frame.thumb, excerpt: excerpt.slice(0, 160), topic, engine: result.engine, ts: now };
  if (window.VXCustom) VXCustom.pushCustomMsg(cu.id, msg);
  Watcher.statusText = `已推送消息给「${cu.name}」`;
  toast(`${cu.name}：${text.slice(0, 30)}`, 3000);
  addLog({ action: 'push', reason: `已主动发给「${cu.name}」`, thumb: frame.thumb, excerpt: excerpt.slice(0, 160), topic, engine: result.engine, msgId: msg.id, ts: now });
  save();
  renderRecCenter();
}

/* 手机模式：截图上传识别 */
async function fileToFrame(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => {
        const maxW = 1100;
        const scale = Math.min(1, maxW / im.width);
        const w = Math.max(2, Math.round(im.width * scale));
        const h = Math.max(2, Math.round(im.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        const full = c.toDataURL('image/jpeg', 0.72);
        const tw = 320, th = Math.max(2, Math.round(h * (320 / w)));
        const tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(c, 0, 0, tw, th);
        resolve({ full, thumb: tc.toDataURL('image/jpeg', 0.6) });
      };
      im.onerror = () => resolve(null);
      im.src = r.result;
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}
async function analyzeShots(files) {
  const list = [...files].slice(0, 3);
  if (!list.length) return;
  const cu = (db.customs || []).find(x => x.id === db.settings.targetId && x.friendStatus === 'accepted')
    || (db.customs || []).find(x => x.friendStatus === 'accepted');
  if (!cu) { toast('先创建并添加一个定制角色，TA 才能收到消息', 2500); return; }
  Watcher.busy = true;
  renderGlobalState();
  for (const f of list) {
    Watcher.statusText = '截图识别中…';
    renderRecCenter();
    const frame = await fileToFrame(f);
    if (!frame) continue;
    db.stats.frames++;
    try { await processFrame(frame, true); }
    catch (err) {
      const msg = err.message || String(err);
      Watcher.statusText = msg;
      addLog({ action: 'skip', reason: '识别异常：' + msg, thumb: null, ts: Date.now() });
      save(); renderRecCenter();
    }
  }
  Watcher.busy = false;
  renderGlobalState();
}

/* =========================================================
 * 核心 2：识别引擎（本地 OCR / 视觉大模型）
 * ========================================================= */
async function recognize(frame) {
  if (db.settings.engine === 'vision') return recognizeByVision(frame);
  return recognizeByOCR(frame);
}
async function recognizeByOCR(frame) {
  if (!window.Tesseract) throw new Error('OCR 组件未加载，请检查网络后刷新');
  if (Watcher.ocrFailed) throw new Error('OCR 加载失败，请在设置中切换到「视觉大模型」引擎');
  if (!Watcher.worker) {
    Watcher.statusText = '加载 OCR 语言包（首次约 30MB，请稍候）…';
    renderRecCenter();
    const p = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000));
    try {
      Watcher.worker = await Promise.race([
        Tesseract.createWorker('chi_sim+eng', 1, {
          logger: m => {
            const prog = Math.round((m.progress || 0) * 100);
            const map = {
              'loading tesseract core': '加载 OCR 核心',
              'initializing tesseract': '初始化 OCR',
              'loading language traineddata': '下载语言包',
              'initializing api': '初始化识别引擎',
              'recognizing text': 'OCR 识别中'
            };
            const label = map[m.status] || m.status;
            Watcher.statusText = `${label} ${prog}%`;
            renderRecCenter();
          }
        }),
        p
      ]);
    } catch (e) {
      Watcher.ocrFailed = true;
      if (e.message === 'timeout') throw new Error('OCR 语言包下载超时，请切换到「视觉大模型」引擎');
      throw new Error('OCR 加载失败：' + (e?.message || '网络异常') + '，可切到视觉模型');
    }
  }
  Watcher.statusText = 'OCR 识别中…';
  const { data } = await Watcher.worker.recognize(frame.full);
  const text = (data.text || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, ' ').trim();
  Watcher.statusText = '';
  return { engine: 'ocr', text, topic: classifyTopic(text), summary: text.slice(0, 80) };
}
async function recognizeByVision(frame) {
  const { base, key, model } = db.settings.vision;
  if (!key) throw new Error('未配置视觉模型 Key，可在「我的 → 视觉模型」中填写，或切回本地 OCR');
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000);
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: ctrl.signal,
    body: JSON.stringify({
      model,
      temperature: 0.4,
      stream: false,
      messages: [
        { role: 'system', content: '你是屏幕内容分析器。根据截图输出 JSON（不要输出其他内容）：{"topic":"话题","summary":"50字内画面摘要","text":"屏幕上的关键文字，没有则留空"}。topic 只能取：美食、购物、游戏、学习、视频娱乐、社交、工作新闻、其他。' },
        { role: 'user', content: [{ type: 'text', text: '分析这张屏幕截图' }, { type: 'image_url', image_url: { url: frame.full } }] }
      ]
    })
  });
  if (!res.ok) throw new Error('视觉接口请求失败（HTTP ' + res.status + '）');
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('视觉模型返回格式异常');
  const parsed = JSON.parse(m[0]);
  return { engine: 'vision', text: parsed.text || '', summary: parsed.summary || '', topic: parsed.topic || '其他' };
}

/* 主动消息文案：本地话题话术 */
function pickTopicLine(c, topic, excerpt) {
  const lines = c.topicLines[topic] || c.bank;
  return lines[Math.floor(Math.random() * lines.length)];
}
/* DeepSeek 根据 OCR 文本生成角色化主动消息（复用真人聊天引擎，screen 模式） */
async function deepSeekComment(c, excerpt, topic) {
  const bubbles = await generateReply(c, 'screen', { topic, excerpt });
  return bubbles[0] || null;
}

/* ---------------- 识别日志 ---------------- */
function addLog(entry) {
  db.recLog.unshift(entry);
  if (db.recLog.length > 40) db.recLog.length = 40;
}

/* =========================================================
 * 核心 3：定时主动消息（与屏幕识别相互独立）
 * ========================================================= */
async function scheduledTick() {
  if (!db.settings.scheduled) return;
  if (isBlocked(db.settings.targetId)) return;
  const d = new Date();
  const hm = d.getHours() * 60 + d.getMinutes();
  const key = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  let win = null;
  if (hm >= 11 * 60 + 30 && hm <= 13 * 60) win = 'noon';
  else if (hm >= 20 * 60 && hm <= 23 * 60) win = 'eve';
  else if (hm >= 15 * 60 && hm <= 17 * 60) win = 'afternoon';
  else if (hm >= 22 * 60 && hm <= 24 * 60) win = 'night';
  if (!win) return;
  const flag = key + win;
  if (db.schedKeys.includes(flag)) return;
  db.schedKeys.push(flag);
  if (db.schedKeys.length > 20) db.schedKeys.shift();
  const cu = (db.customs || []).find(x => x.id === db.settings.targetId && x.friendStatus === 'accepted')
    || (db.customs || []).find(x => x.friendStatus === 'accepted');
  if (!cu) return;
  let text = '';
  if (db.settings.deepseekKey) {
    try {
      const sys = `你是${cu.name}，${cu.persona?.relation || '用户的好友'}。性格：${cu.persona?.personality || ''}。现在你主动给用户发一条${win === 'noon' ? '午间（问问吃饭）' : win === 'afternoon' ? '下午（关心活动一下）' : '晚间（聊聊今天/催睡）'}的微信消息，一条、20字内，像顺手发的，不要AI腔。`;
      const raw = await callLLM(sys, [], 0.9);
      text = raw ? raw.split(/\n+/)[0].trim().slice(0, 40) : '';
    } catch (e) { text = ''; }
  }
  if (!text) text = ['吃饭了没？', '在忙什么？', '记得喝水。', '别熬太晚。'][Math.floor(Math.random() * 4)];
  if (window.VXCustom) VXCustom.pushCustomMsg(cu.id, { id: uid(), from: 'them', type: 'text', text, ts: Date.now() });
  save();
  /* 悬浮通知横幅：仅当停留在聊天列表时弹出 */
  if (window.VXPhone && currentPage === 'chats') VXPhone.showBanner(cu.id, text);
}
const CHECKIN = {
  shenmz: {
    noon: ['该吃饭了，别又忘了。', '中午吃点热乎的，别对付。', '饭点了，放下手头的事。'],
    afternoon: ['下午困不困，起来喝口水。', '别一直坐着，活动两分钟。', '工作再忙也歇会儿。'],
    night: ['几点了还不睡？', '别熬了，明天再说。', '放下手机，闭眼。']
  },
  xunn: {
    noon: ['宝吃饭没！', '中午吃啥了！', '到饭点啦宝！'],
    afternoon: ['宝下午摸鱼没哈哈', '下午茶点了吗！', '宝你在干嘛呢'],
    night: ['宝别熬夜！', '晚安宝！', '这么晚还醒着？']
  }
};
function randomCheckin(c, win) {
  const set = CHECKIN[c.id] || CHECKIN.shenmz;
  const arr = set[win] || set.noon;
  return arr[Math.floor(Math.random() * arr.length)];
}
setInterval(() => { scheduledTick(); }, 30000);

/* 微信步数模拟：计步开启时每隔一段时间随机增加 */
setInterval(() => {
  if (!db.stepsCounting) return;
  const add = Math.floor(Math.random() * 8) + 1;
  db.steps += add;
  save();
  const v = $('#meStepsVal');
  if (v) v.textContent = `${db.steps} 步 · 计步中(点停)`;
}, 7000);

/* 屏幕识别主动消息：按定制角色人设生成 */
async function customScreenText(cu, topic, excerpt) {
  if (!db.settings.deepseekKey) return null;
  const sys = `你是${cu.name}，${cu.persona?.relation || '用户的好友'}。性格：${cu.persona?.personality || ''}。背景：${String(cu.persona?.background || '').slice(0, 500)}。说话口语化、短句，像真人发微信，不要AI腔。`;
  const raw = await callLLM(sys, [{ role: 'user', content: `用户正在看手机，屏幕话题：${topic}。识别到的文字：${String(excerpt).slice(0, 200)}。请主动发一条20字以内的消息搭话，紧扣看到的内容，别复述系统说明，别编造没有的细节。` }], 0.9);
  return raw ? raw.split(/\n+/)[0].trim().slice(0, 60) : null;
}

/* ---------------- 识别中心 UI ---------------- */
function renderRecCenter() {
  const s = db.settings;
  const cu = (db.customs || []).find(x => x.id === s.targetId) || (db.customs || []).find(x => x.friendStatus === 'accepted');
  const tname = cu ? cu.name : '你的角色';
  const last = db.recLog[0];
  $('#recWrap').innerHTML = `
    <div class="rec-hero ${Watcher.running ? 'on' : ''}">
      <h2>${Watcher.running ? '🟢 屏幕识别运行中' : '⚪ 屏幕识别未开启'}</h2>
      <p>${Watcher.running
        ? `正在监听你共享的屏幕，画面发生明显变化并识别到内容时，${esc(tname)} 会主动给你发消息。`
        : '开启后选择要共享的屏幕/窗口/标签页。所有画面默认只在本机处理（本地 OCR），可随时停止。'}</p>
      <button class="rec-big-btn ${Watcher.running ? 'stop' : ''}" data-act="${Watcher.running ? 'stop-rec' : 'start-rec'}">
        ${Watcher.running ? '■ 停止识别' : '▶ 开始屏幕识别'}
      </button>
      <div class="rec-stats">
        <div class="rec-stat"><b>${db.stats.frames}</b><span>已分析帧</span></div>
        <div class="rec-stat"><b>${db.stats.pushed}</b><span>主动消息</span></div>
        <div class="rec-stat"><b>${db.stats.skipped}</b><span>去重拦截</span></div>
      </div>
    </div>

    <div class="rec-live">
      <h4>� 手机截图识别</h4>
      <div class="live-line"><span class="k">适用场景</span>手机/平板浏览器无法共享屏幕时，把聊天截图、游戏画面、课程页面等截图上传，${esc(tname)} 同样会识别内容并主动找你</div>
      <button class="rec-big-btn" data-act="rec-upload-shots" style="margin-top:10px">🖼 上传截图识别（最多 3 张）</button>
      <input type="file" id="recShotInput" accept="image/*" multiple hidden>
      <div class="live-line" style="margin-top:8px"><span class="k">截图状态</span>${esc(Watcher.statusText || '等待上传截图')}</div>
    </div>

    <div class="rec-live">
      <h4>� 实时状态</h4>
      <div class="live-line"><span class="k">识别引擎</span>${s.engine === 'ocr' ? '本地 OCR（Tesseract 中英）' : '视觉大模型（' + esc(s.vision.model) + '）'}</div>
      <div class="live-line"><span class="k">采样间隔</span>${s.intervalSec} 秒/次 ｜ 冷却 ${s.cooldownSec} 秒/条 ｜ 灵敏度 ${{ high: '高', mid: '中', low: '低' }[s.sensitivity] || '中'}</div>
      <div class="live-line"><span class="k">接收角色</span>${(() => { const t = (db.customs || []).find(x => x.id === s.targetId && x.friendStatus === 'accepted') || (db.customs || []).find(x => x.friendStatus === 'accepted'); return t ? esc(t.name) + '（定制角色）' : '未设置，可在识别配置中选择'; })()}</div>
      <div class="live-line"><span class="k">当前状态</span>${esc(Watcher.statusText || (Watcher.running ? (Watcher.busy ? '识别中…' : '等待画面变化') : '空闲'))}</div>
      ${Watcher.lastDist != null ? `<div class="live-line"><span class="k">上次画面差异</span>${Watcher.lastDist} / 阈值 ${HAMMING_THRESHOLD[s.sensitivity]}</div>` : ''}
      ${last?.thumb ? `<img class="live-preview show" src="${last.thumb}">` : ''}
      ${last?.excerpt ? `<div class="live-line" style="margin-top:8px"><span class="k">最近识别</span>${esc(last.excerpt.slice(0, 90))}</div>` : ''}
    </div>

    <div class="wx-group">
      <button class="wx-row" data-act="open-demo"><span class="wx-ic ic-eye">演</span><span style="flex:1;text-align:left">演示内容页<small style="display:block;color:#999;font-size:11px;margin-top:2px">不知道共享什么？打开此页再共享本标签页即可测试</small></span><span class="arrow">›</span></button>
      <button class="wx-row" data-act="open-settings"><span class="wx-ic ic-key">设</span><span style="flex:1;text-align:left">识别设置与模型配置</span><span class="arrow">›</span></button>
    </div>

    <div class="section-title">识别日志（最近 ${db.recLog.length} 条）</div>
    <div style="padding:0 12px 24px">
      ${db.recLog.length ? db.recLog.map(l => `
        <div class="log-item">
          ${l.thumb ? `<img class="log-thumb" src="${l.thumb}" data-act="preview-img" data-src="${l.thumb}">` : `<div class="log-thumb" style="display:flex;align-items:center;justify-content:center;color:#888;font-size:20px;background:#222">${l.action === 'push' ? '👁' : '⏭'}</div>`}
          <div class="log-main">
            <div class="log-top"><span class="log-topic ${l.action === 'skip' ? 'skip' : ''}">${esc(l.topic || '画面事件')} · ${l.engine === 'vision' ? '视觉模型' : l.engine === 'ocr' ? 'OCR' : '感知'}</span><span class="log-time">${fmtHM(l.ts)}</span></div>
            ${l.excerpt ? `<div class="log-excerpt">${esc(l.excerpt)}</div>` : ''}
            <div class="log-reason ${l.action}">${l.action === 'push' ? '✓ ' : '⏭ '}${esc(l.reason)}</div>
          </div>
        </div>`).join('') : '<div class="empty-tip">还没有识别记录<br>开启屏幕识别后，每一次分析都会记录在这里</div>'}
    </div>`;
  renderGlobalState();
}

/* 演示内容页：文字清晰，便于 OCR 验证 */
const DEMO_CARDS = [
  { tag: '美食', title: '三分钟学会懒人焖饭，电饭煲一焖满屋飘香', meta: '深夜食堂小周 · 12.8万赞', cover: '美食短视频封面，电饭煲懒人焖饭特写，热气腾腾，暖色灯光，诱人' },
  { tag: '学习', title: '考研英语四级冲刺：阅读高频题型拆解与关键词定位法', meta: '上岸进行时 · 4.5万收藏', cover: '整洁书桌学习计划与计时器，晨光，励志学习氛围摄影' },
  { tag: '购物', title: '黄皮姐妹闭眼入！三支显白口红试色，限时优惠券领取', meta: '种草机器鹿 · 1.8万赞', cover: '三支口红试色平铺，温柔奶茶色调，美妆摄影，精致杂志风' },
  { tag: '游戏', title: '王者荣耀新赛季段位继承规则解读，开黑上分阵容推荐', meta: '电竞老司机 · 8.2万播放', cover: '手机游戏对战画面，绚丽技能特效，电竞风格摄影' },
  { tag: '视频娱乐', title: '街头采访：你最近一次心动是什么时候？结尾反转太好哭', meta: '城市漫游者 · 23.1万赞', cover: '城市街头夜景采访画面，霓虹灯光，电影感摄影' },
  { tag: '工作新闻', title: '互联网行业周报：本周会议纪要与招聘趋势汇总', meta: '职场观察 · 新闻早报', cover: '现代办公室笔记本电脑与咖啡，商务摄影，冷色调' }
];
function openDemo() {
  $('#demoFeed').innerHTML = `
    <div class="demo-tip">使用方法：<br>1. 回到「识别」页点「开始屏幕识别」<br>2. 在浏览器弹窗中选择共享<b>当前这个标签页</b><br>3. 回到本页上下滑动，角色识别到不同内容就会主动发消息</div>
    ${DEMO_CARDS.map(d => `
      <div class="demo-card">
        <img class="cover" src="https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(d.cover)}&image_size=landscape_16_9">
        <div class="demo-body"><div class="demo-title">【${d.tag}】${d.title}</div><div class="demo-meta"><span>${d.meta}</span></div></div>
      </div>`).join('')}`;
  $('#demoPage').classList.add('active');
  $('#demoPage').style.display = 'flex';
}

/* ---------------- 我的 / 设置 ---------------- */
function renderMe() {
  const s = db.settings;
  const pf = db.profile || {};
  const ident = curIdent();
  const name = (pf.name && pf.name !== '我') ? pf.name : (ident.name || '我');
  const wcid = ident.wcid || 'wx_me';
  const avatar = pf.avatar || ident.avatar || svgMe();
  const sign = pf.bio || (db.globalPersona ? db.globalPersona.slice(0, 28) : '这个人很懒，什么都没留下～');
  const bal = (db.wallet?.balance || 0).toFixed(2);
  $('#meWrap').innerHTML = `
    <div class="me-header">
      <div class="me-avatar-wrap"><img class="avatar" src="${avatar}"></div>
      <div style="flex:1;min-width:0">
        <div class="me-name">${esc(name)}</div>
        <div class="me-sign">${esc(sign)}</div>
        <div class="me-wcid">微信号：${esc(wcid)}</div>
      </div>
      <button class="me-qr" data-act="edit-profile" title="编辑资料">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    </div>
    <div class="wx-group">
      <button class="wx-row" data-act="open-wallet">
        <span class="wx-ic ic-key"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M16 12h2M2 10h20"/></svg></span>钱包
        <span class="val">¥${bal}</span><span class="arrow">›</span>
      </button>
      <button class="wx-row" data-act="edit-persona">
        <span class="wx-ic ic-bell"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>我的人设（全局）
        <span class="val">${db.globalPersona ? '已设置' : '未设置'}</span><span class="arrow">›</span>
      </button>
    </div>
    <div class="wx-group">
      <button class="wx-row" data-act="open-lockset">
        <span class="wx-ic ic-key" style="background:#5856d6"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg></span>
        <span style="flex:1;text-align:left">锁屏设置</span>
        <span class="val">${db.lock && db.lock.enabled ? '已开启 · ' + esc(db.lock.password) : '已关闭'}</span><span class="arrow">›</span>
      </button>
    </div>
    <div class="wx-group">
      <button class="wx-row" data-act="open-settings"><span class="wx-ic ic-rec"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>识别设置<span class="arrow">›</span></button>
      <button class="wx-row" data-act="open-apikey"><span class="wx-ic ic-key"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg></span>DeepSeek 文案生成<span class="val">${s.deepseekKey ? '已配置' : '未配置'}</span><span class="arrow">›</span></button>
      <button class="wx-row" data-act="open-vision"><span class="wx-ic ic-eye"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>视觉大模型<span class="val">${s.vision.key ? '已配置' : '未配置'}</span><span class="arrow">›</span></button>
    </div>
    <div class="wx-group">
      <div class="wx-row"><span class="wx-ic ic-info"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><path d="M21 3l-9 9"/></svg></span>深色模式<span class="switch ${db.dark ? 'on' : ''}" data-act="toggle-dark"><i></i></span></div>
      <div class="wx-row"><span class="wx-ic ic-bell"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>定时主动消息（中午/晚上）<span class="switch ${s.scheduled ? 'on' : ''}" data-act="toggle-scheduled"><i></i></span></div>
      <button class="wx-row" data-act="page-rec"><span class="wx-ic ic-log"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg></span>屏幕识别<span class="arrow">›</span></button>
    </div>
    <div class="wx-group">
      <button class="wx-row" data-act="clear-data"><span class="wx-ic ic-cache">清</span>清除所有数据<span class="arrow">›</span></button>
      <button class="wx-row" data-act="privacy"><span class="wx-ic ic-info">隐</span>隐私说明<span class="arrow">›</span></button>
    </div>`;
  if (window.VXCustom) VXCustom.mountMe();
  if (window.VXMoments) VXMoments.mountMe();
}
function openWalletSheet() {
  const bal = (db.wallet?.balance || 0).toFixed(2);
  const rps = (db.wallet?.redpacks || []).slice().sort((a, b) => b.ts - a.ts);
  openSubPage('钱包', `
      <div style="background:linear-gradient(135deg,#f7d774,#f5b942);border-radius:14px;padding:22px;color:#5a3a00;margin-bottom:16px">
        <div style="font-size:13px;opacity:.8">零钱（元）</div>
        <div style="font-size:30px;font-weight:700;margin-top:6px">¥${bal}</div>
      </div>
      <div class="section-title" style="margin:0 2px 8px">红包记录（${rps.length}）</div>
      <div class="wx-group" style="margin:0 0 16px">
        ${rps.length ? rps.slice(0, 20).map(r => `
          <div class="wx-row" style="cursor:default">
            <span class="wx-ic" style="background:${r.type === 'out' ? '#fa5151' : '#fa9d3b'}">🧧</span>
            <span style="flex:1;text-align:left">${r.type === 'out' ? '发给 ' + esc(r.to || '好友') : '收到红包'}<small style="display:block;color:#999;font-size:11px;margin-top:2px">${esc(r.remark || '')} · ${fmtHM(r.ts)}</small></span>
            <span class="val" style="color:${r.type === 'out' ? '#fa5151' : '#07c160'}">${r.type === 'out' ? '-' : '+'}${r.amount}</span>
          </div>`).join('') : '<div class="empty-tip" style="padding:20px">还没有红包记录</div>'}
      </div>
      <p style="font-size:12px;color:#999;margin-top:14px;line-height:1.7">本钱包仅为模拟数据，不涉及任何真实扣款与支付。</p>`);
}
function editPersonaSheet() {
  openSubPage('我的人设（全局）', `
      <p style="font-size:12.5px;color:#777;line-height:1.8">所有人设角色都能看到这段关于你的描述，TA 们会据此与你互动。例如："22 岁大学生，喜欢熬夜追剧，嘴硬心软，爱吃甜的"。</p>
      <textarea class="wiz-input" id="gpText" rows="6" style="resize:none;line-height:1.6;margin-top:10px" placeholder="写下你希望角色了解的你自己…">${esc(db.globalPersona)}</textarea>
      <button class="wiz-btn" id="gpSave">保存</button>`);
  $('#gpSave').onclick = () => {
    db.globalPersona = $('#gpText').value.trim();
    save(); closeSubPage(); renderMe(); toast('全局人设已保存');
  };
}
function openSettings() {
  const s = db.settings;
  openSubPage('识别设置', `
      <div class="wiz-label">识别引擎</div>
      <div class="seg" id="segEngine">
        <button class="${s.engine === 'ocr' ? 'on' : ''}" data-act="set-engine" data-v="ocr">本地 OCR（免费·隐私）</button>
        <button class="${s.engine === 'vision' ? 'on' : ''}" data-act="set-engine" data-v="vision">视觉大模型（更准）</button>
      </div>
      <div class="wiz-label">采样间隔</div>
      <div class="seg" id="segInterval">${[3, 5, 10].map(n => `<button class="${s.intervalSec === n ? 'on' : ''}" data-act="set-interval" data-v="${n}">${n} 秒</button>`).join('')}</div>
      <div class="wiz-label">主动消息冷却（去重）</div>
      <div class="seg" id="segCooldown">${[30, 60, 120, 300].map(n => `<button class="${s.cooldownSec === n ? 'on' : ''}" data-act="set-cooldown" data-v="${n}">${n} 秒</button>`).join('')}</div>
      <div class="wiz-label">画面变化灵敏度（哈希阈值）</div>
      <div class="seg" id="segSens">
        <button class="${s.sensitivity === 'high' ? 'on' : ''}" data-act="set-sens" data-v="high">高（细微变化）</button>
        <button class="${s.sensitivity === 'mid' ? 'on' : ''}" data-act="set-sens" data-v="mid">中</button>
        <button class="${s.sensitivity === 'low' ? 'on' : ''}" data-act="set-sens" data-v="low">低（大变化）</button>
      </div>
      <div class="wiz-label">读屏主动消息接收人</div>
      <div class="seg" id="segTarget">${(db.customs || []).filter(c => c.friendStatus === 'accepted').map(c => `<button class="${s.targetId === c.id ? 'on' : ''}" data-act="set-target" data-v="${c.id}">${esc(c.name)}</button>`).join('') || '<button disabled style="color:#777">先创建一个角色</button>'}</div>
      <div class="privacy-note" style="margin:16px 0 0">本地 OCR 模式下，屏幕画面不会上传任何服务器；视觉模型模式下，仅在画面变化时向你配置的接口发送压缩截图。停止识别即彻底结束采集。</div>`);
}
function openApiKey() {
  openSubPage('DeepSeek 文案生成', `
      <p style="font-size:12.5px;color:#777;line-height:1.8">配置后角色回复由 DeepSeek 大模型生成：带多轮聊天记忆，真人微信口吻（短句口语、会吐槽会追问、偶尔分多条消息发）；读屏主动消息和定时问候同样由模型生成（纯文本调用，不传输截图）。不配置则使用内置话术兜底。Key 仅存本浏览器。</p>
      <div class="wiz-label">API Key</div>
      <input class="wiz-input" id="dsKey" type="password" placeholder="sk-..." value="${esc(db.settings.deepseekKey)}">
      <button class="wiz-btn" id="dsSave">保存</button>`);
  $('#dsSave').onclick = () => { db.settings.deepseekKey = $('#dsKey').value.trim(); save(); closeSubPage(); renderMe(); toast('已保存'); };
}
function openVision() {
  const v = db.settings.vision;
  openSubPage('视觉大模型', `
      <p style="font-size:12.5px;color:#777;line-height:1.8">兼容 OpenAI 接口的视觉模型，识别引擎切换为「视觉大模型」后生效。常用：通义千问 qwen-vl-max、智谱 glm-4v-plus、OpenAI gpt-4o。DeepSeek 暂不支持图片输入。</p>
      <div class="wiz-label">接口地址 Base URL</div>
      <input class="wiz-input" id="vBase" value="${esc(v.base)}">
      <div class="wiz-label">API Key</div>
      <input class="wiz-input" id="vKey" type="password" placeholder="sk-..." value="${esc(v.key)}">
      <div class="wiz-label">模型名 Model</div>
      <input class="wiz-input" id="vModel" value="${esc(v.model)}">
      <button class="wiz-btn" id="vSave">保存并切换到视觉引擎</button>
      <button class="wiz-btn ghost" id="vBack">切回本地 OCR</button>`);
  $('#vSave').onclick = () => {
    db.settings.vision = { base: $('#vBase').value.trim(), key: $('#vKey').value.trim(), model: $('#vModel').value.trim() || 'qwen-vl-max' };
    db.settings.engine = 'vision';
    save(); closeSubPage(); renderMe(); toast('已保存，识别引擎切换为视觉大模型');
  };
  $('#vBack').onclick = () => { db.settings.engine = 'ocr'; save(); closeSubPage(); renderMe(); toast('已切回本地 OCR'); };
}
function privacySheet() {
  openSubPage('隐私说明', `
      <div class="pay-box" style="padding:14px 16px;font-size:13px;line-height:2;color:#555">
        1. 屏幕识别<b>默认关闭</b>，必须你手动点击并在浏览器弹窗授权后才会采集；<br>
        2. 本地 OCR 模式：画面仅在当前设备内分析，<b>不上传任何截图</b>；<br>
        3. 视觉模型模式：仅画面发生明显变化时，向你自行配置的接口发送压缩截图；<br>
        4. 主动消息受冷却时间与话题去重约束，不会刷屏，所有决策在「识别日志」可查；<br>
        5. 点击停止或浏览器自带的停止共享按钮，采集立即结束；<br>
        6. 所有数据仅保存在本浏览器 localStorage，清除数据即彻底删除。
      </div>`);
}

/* ---------------- 弹层 ---------------- */
function openSheet(html) {
  closeSheet();
  /* 未自带 sheet-body 的内容统一包一层滚动容器，避免长表单被弹层高度裁切 */
  const body = /class="[^"]*sheet-body/.test(html)
    ? html
    : `<div class="sheet-body" style="padding-top:10px">${html}</div>`;
  $('#sheetRoot').innerHTML = `<div class="sheet-mask" data-act="close-sheet"></div>
    <div class="sheet"><div class="sheet-handle"></div>${body}</div>`;
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; }

/* ---------------- 全屏子页（微信风「点开进入下一页」） ---------------- */
function openSubPage(title, bodyHtml) {
  closeSheet();
  let sp = document.getElementById('dynSubPage');
  if (!sp) {
    sp = document.createElement('div');
    sp.id = 'dynSubPage';
    sp.className = 'subpage';
    document.querySelector('.app').appendChild(sp);
  }
  sp.innerHTML = `
    <div class="nav-bar">
      <button class="nav-btn" data-act="close-subpage"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="nav-title">${esc(title)}</div>
      <span style="width:34px;display:inline-block"></span>
    </div>
    <div class="sub-scroll">${bodyHtml}</div>`;
  sp.classList.add('active');
  sp.style.display = 'flex';
  const sc = sp.querySelector('.sub-scroll');
  if (sc) sc.scrollTop = 0;
}
function closeSubPage() {
  const sp = document.getElementById('dynSubPage');
  if (sp) { sp.classList.remove('active'); sp.style.display = 'none'; }
}
function previewImg(src) {
  openSheet(`<div class="sheet-body" style="padding-top:14px">
    <img src="${src}" style="width:100%;border-radius:12px">
    <button class="wiz-btn ghost" data-act="close-sheet">关闭</button></div>`);
}

/* ---------------- 微信右上角 + 下拉菜单 ---------------- */
function openPlusPop() {
  closePlusPop();
  const pop = document.createElement('div');
  pop.id = 'plusPop';
  pop.className = 'plus-pop';
  pop.innerHTML = `
    <button data-act="pp-custom"><i>🎭</i>定制专属陪伴<span>免费试用</span></button>
    <button data-act="pp-moment"><i>📷</i>发朋友圈</button>
    <button data-act="pp-friends"><i>👋</i>新的朋友</button>`;
  document.getElementById('phone').appendChild(pop);
  setTimeout(() => document.addEventListener('click', plusPopOutside, true), 0);
}
function plusPopOutside(e) {
  const pop = document.getElementById('plusPop');
  if (!pop) { document.removeEventListener('click', plusPopOutside, true); return; }
  if (pop.contains(e.target)) return;   // 点菜单项走 data-act handler
  pop.remove();
  document.removeEventListener('click', plusPopOutside, true);
}
function closePlusPop() {
  document.getElementById('plusPop')?.remove();
  document.removeEventListener('click', plusPopOutside, true);
}

/* ---------------- 全局事件 ---------------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'start-rec': startWatching(); break;
    case 'stop-rec': stopWatching('屏幕识别已停止'); break;
    case 'open-chat': closeSheet(); openChat(el.dataset.id); break;
    case 'cr-back': currentChat = null; showPage('chats'); break;
    case 'chats-add': {
      /* 微信右上角 + 弹出菜单（含误删后补回的「定制专属陪伴」入口） */
      openPlusPop();
      break;
    }
    case 'pp-custom': closePlusPop(); if (window.VXCustom && VXCustom.openCustomShop) VXCustom.openCustomShop(); break;
    case 'pp-moment': closePlusPop(); showPage('moments'); break;
    case 'pp-friends': closePlusPop(); if (window.VXMoments && VXMoments.renderFreqPage) VXMoments.renderFreqPage(); break;
    case 'send-text': sendText(); break;
    case 'cr-plus': {
      /* 输入文字后 + 变绿色发送键（微信同款） */
      if (el.classList && el.classList.contains('is-send')) sendText();
      break;
    }
    case 'cr-emoji': if (window.VXCustom && VXCustom.openEmojiPanel) VXCustom.openEmojiPanel(); break;
    case 'open-demo': openDemo(); break;
    case 'demo-back': $('#demoPage').classList.remove('active'); $('#demoPage').style.display = 'none'; break;
    case 'page-rec': closeSheet(); showPage('rec'); break;
    case 'rec-upload-shots': $('#recShotInput')?.click(); break;
    case 'page-moments': closeSheet(); showPage('moments'); break;
    case 'edit-profile': break;   // 个人资料由 moments.js 全屏页处理
    case 'set-online-to': {
      db.online = el.dataset.v;
      save(); renderMe();
      toast('在线状态：' + ({ auto: '自动', online: '在线', offline: '离线' }[db.online]));
      break;
    }
    case 'open-wallet': openWalletSheet(); break;
    case 'edit-persona': editPersonaSheet(); break;
    case 'open-settings': openSettings(); break;
    case 'open-apikey': openApiKey(); break;
    case 'open-vision': openVision(); break;
    case 'privacy': privacySheet(); break;
    case 'close-sheet': closeSheet(); break;
    case 'close-subpage': closeSubPage(); break;
    case 'preview-img': previewImg(el.dataset.src); break;
    case 'play-voice': playVoiceMsg(el.dataset.mid); break;
    case 'play-song': playSongCard(el.dataset.mid); break;
    case 'set-engine': db.settings.engine = el.dataset.v; save(); openSettings(); break;
    case 'set-interval': db.settings.intervalSec = +el.dataset.v; save(); openSettings(); break;
    case 'set-cooldown': db.settings.cooldownSec = +el.dataset.v; save(); openSettings(); break;
    case 'set-sens': db.settings.sensitivity = el.dataset.v; save(); openSettings(); break;
    case 'set-target': db.settings.targetId = el.dataset.v; save(); openSettings(); break;
    case 'toggle-scheduled': db.settings.scheduled = !db.settings.scheduled; save(); renderMe(); break;
    case 'toggle-dark': db.dark = !db.dark; save(); applyTheme(); renderMe(); break;
    case 'open-ident': renderIdentities(); break;
    case 'switch-ident': db.curIdent = el.dataset.id; save(); closeSheet(); toast('已切换到「' + curIdent().name + '」'); break;
    case 'add-ident': addIdentitySheet(); break;
    case 'open-trial': closeSheet(); openTrial(); break;
    case 'trial-close':
    case 'trial-hall': $('#trialPage').classList.remove('active'); $('#trialPage').style.display = 'none'; break;
    case 'trial-restart': openTrial(); break;
    case 'trial-opt': {
      const opt = +el.dataset.i;
      db.trial.answers.push(opt);
      const s = scoreAnswer(trialIdx, opt);
      TRIAL_DIMS.forEach((k, i) => { db.trial.dims[k] = Math.round(((db.trial.dims[k] * trialIdx) + s[i]) / (trialIdx + 1)); });
      save();
      trialIdx++;
      renderTrial();
      break;
    }
    case 'cr-make-reply': { const c = getChar(currentChat); if (c) makeCharacterReply(c); break; }
    case 'delete-chat': askDeleteChat(el.dataset.id); break;
    case 'confirm-delete-chat': deleteChat(el.dataset.id); break;
    case 'open-groups': closeSheet(); toast('群聊功能开发中，敬请期待'); break;
    case 'cc-make-reply': { if (window.VXCustom) VXCustom.makeReply(); break; }
    case 'clear-data':
      openSheet(`<div class="sheet-body" style="padding-top:16px">
        <h3 style="font-size:17px;margin-bottom:8px">清除所有数据？</h3>
        <p style="font-size:13px;color:#777;line-height:1.7">聊天、识别日志、配置与 Key 都会被删除。</p>
        <button class="wiz-btn" id="cdOk">确定清除</button>
        <button class="wiz-btn ghost" data-act="close-sheet">取消</button></div>`);
      $('#cdOk').onclick = () => { localStorage.removeItem(LS_KEY); location.reload(); };
      break;
  }
});
$$('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.page)));
$('#msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });

/* 图片失败兜底 */
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.fb) return;
  img.dataset.fb = '1';
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='#334'/><text x='50%' y='54%' font-size='60' text-anchor='middle' fill='#88a' font-family='sans-serif' dominant-baseline='middle'>VX</text></svg>");
}, true);

/* 状态栏按要求留空（req12：不显示时间） */

/* 启动 */
load();
closeSheet();
/* 手机截图识别：input 绑定 */
(() => {
  const shotInp = document.getElementById('recShotInput');
  if (shotInp) shotInp.onchange = e => {
    const fs = e.target.files;
    if (fs && fs.length) analyzeShots(fs);
    e.target.value = '';
  };
})();
try {
  showPage('chats');
  renderRecCenter();
  renderMe();
} catch (e) { console.error('启动渲染异常', e); toast('页面初始化异常，请刷新重试'); }

/* ---------------- v2 模块公共接口 ---------------- */
window.VX = {
  get db() { return db; },
  set db(v) { db = v; },
  save, uid, esc, toast, openSheet, closeSheet, openSubPage, closeSubPage, showPage, renderChats, renderMe, updateBadges, previewImg,
  getChar, CHARACTERS, callLLM, buildSystemPrompt, fmtHM, fmtClock, pad2, svgMe,
  LS_KEY,
  img(prompt, size = 'landscape_16_9') {
    return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;
  }
};
