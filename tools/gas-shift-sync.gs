/**
 * きん太：Googleカレンダーのシフト → Firestore shifts コレクションへの同期
 *
 * きん太のシフトタブを開いたときに、ウェブアプリとして呼ばれる（定期実行はしない）。
 *   GET <ウェブアプリURL>?uid=<AuthUID>&ym=YYYY-MM
 *   → その人のカレンダーのその月の予定を shifts/{uid}_{date} に書き写す
 *
 * 設定
 *  1. シフトのカレンダーを読めて、かつ Firebase プロジェクト kintai-dubstock に
 *     権限のある Google アカウントで、Apps Script プロジェクトを作る
 *  2. このファイルを貼り付け、CONFIG.CALENDARS を埋める（カレンダーID → きん太の氏名）
 *  3. プロジェクトの設定で「appsscript.json をエディタで表示」をオンにし、下の oauthScopes を書く
 *  4. 関数 testSync を一度実行して許可する
 *  5. デプロイ →「ウェブアプリ」／実行ユーザー：自分／アクセス：全員 → URL を index.html の SHIFT_SYNC_URL へ
 *
 * appsscript.json
 *  "oauthScopes": [
 *    "https://www.googleapis.com/auth/calendar.readonly",
 *    "https://www.googleapis.com/auth/datastore",
 *    "https://www.googleapis.com/auth/script.external_request"
 *  ]
 *
 * 仕組み
 *  - 1人1カレンダー。そのカレンダーの予定はすべてその人のシフトとみなす（終日の予定は無視）
 *  - 指定月の shifts を作り直す。カレンダーから消した予定は、きん太からも消える
 *  - Firestore へは OAuth トークンで REST を呼ぶので、セキュリティルールを通らずに書ける
 *  - URL を知っていても、できるのは「登録済みカレンダーの同期」だけ。データは返さない
 *
 * チャットワーク通知（休日申請・経費の提出・出張報告の提出）
 *   GET <URL>?n=leave&id=<leaves のID> / ?n=expense&uid=<UID>&ym=YYYY-MM / ?n=travel&id=<travels のID>
 *  - 本文は Firestore の中身から作る（呼び出し側の文言は使わない）。承認待ち・提出済みのものだけ通知する
 *  - 同じ申請は1回だけ通知する（leaves/travels は notifiedAt、経費は notifyLog に記録）
 *  - スクリプト プロパティに CHATWORK_TOKEN と CHATWORK_ROOM_ID が必要
 *
 * 月次の提出リマインド（勤怠確定・経費確定）
 *  - dailyRemind：毎朝10時台に自動実行（installDailyTrigger で一度だけ設定）。営業日だけ動く
 *    前月分が未提出の人に、通知部屋で本人宛て（[To]）に送る。第4営業日以降は「至急」
 *  - GET <URL>?n=remind&uid=<UID>&ym=YYYY-MM：管理者画面の「催促する」。期限後・未提出・1時間に1回まで
 *  - 祝日・開始月・締めの営業日数は、公開中の hr-common.js から読む（祝日の管理を1か所にするため）
 */

const CONFIG = {
  PROJECT_ID: 'kintai-dubstock',
  CALENDARS: {          // カレンダーID → きん太の氏名（users.name と完全に一致させる）
    // 'xxxxx@group.calendar.google.com': '山下枝里子',
  },
};

const FS = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents';
const DOC = 'projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents';

function doGet(e) {
  // ?n=leave|expense|travel のときはチャットワーク通知、それ以外はシフト同期
  if (e && e.parameter && e.parameter.n) return json_(notify_(e.parameter));
  try {
    const uid = String((e && e.parameter && e.parameter.uid) || '');
    const ym = String((e && e.parameter && e.parameter.ym) || '');
    if (!/^[A-Za-z0-9]{10,64}$/.test(uid) || !/^\d{4}-\d{2}$/.test(ym)) return json_({ ok: false, error: 'bad request' });
    const n = syncMonth_(uid, ym);
    return json_({ ok: true, days: n });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// 手動確認用：今月の全員分を同期してログに出す
function testSync() {
  const ym = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
  const uidByName = loadEmployeeUids_();
  Object.keys(CONFIG.CALENDARS).forEach(cid => {
    const name = CONFIG.CALENDARS[cid];
    const uid = uidByName[name];
    if (!uid) throw new Error('きん太に「' + name + '」さんが見つかりません');
    Logger.log(name + '：' + ym + ' のシフト ' + syncMonth_(uid, ym) + ' 日を同期しました');
  });
}

function syncMonth_(uid, ym) {
  const uidByName = loadEmployeeUids_();
  const cid = Object.keys(CONFIG.CALENDARS).filter(c => uidByName[CONFIG.CALENDARS[c]] === uid)[0];
  if (!cid) throw new Error('この社員のカレンダーは登録されていません');
  const cal = CalendarApp.getCalendarById(cid);
  if (!cal) throw new Error('カレンダーを開けません（共有されているか確認）');

  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1;
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 1);
  // 翌月1日の深夜（〜5時）の予定は当月末の勤務になるため、5時間先まで取る
  const plan = {};
  cal.getEvents(from, new Date(to.getTime() + 5 * 3600000)).forEach(ev => {
    if (ev.isAllDayEvent()) return;
    const s = ev.getStartTime(), e = ev.getEndTime();
    // 深夜0〜5時の開始は前日の勤務として扱う（きん太の勤務日の区切りと同じ）
    const wd = new Date(s.getTime()); if (Number(Utilities.formatDate(wd, 'Asia/Tokyo', 'H')) < 5) wd.setDate(wd.getDate() - 1);
    const date = Utilities.formatDate(wd, 'Asia/Tokyo', 'yyyy-MM-dd');
    if (date.slice(0, 7) !== ym) return;
    (plan[date] = plan[date] || []).push({
      start: Utilities.formatDate(s, 'Asia/Tokyo', 'HH:mm'),
      end: Utilities.formatDate(e, 'Asia/Tokyo', 'HH:mm'),
      title: ev.getTitle() || '',
    });
  });

  const writes = [];
  const stamp = new Date().toISOString();
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const date = ym + '-' + ('0' + d).slice(-2);
    const name = DOC + '/shifts/' + uid + '_' + date;
    const items = plan[date];
    if (!items) { writes.push({ delete: name }); continue; }
    items.sort((a, b) => a.start < b.start ? -1 : 1);
    writes.push({ update: { name: name, fields: {
      userId: { stringValue: uid },
      date: { stringValue: date },
      source: { stringValue: 'gcal' },
      updatedAt: { stringValue: stamp },
      items: { arrayValue: { values: items.map(i => ({ mapValue: { fields: {
        start: { stringValue: i.start }, end: { stringValue: i.end }, title: { stringValue: i.title },
      } } })) } },
    } } });
  }
  fsFetch_(':commit', { writes: writes });
  return Object.keys(plan).length;
}

function loadEmployeeUids_() {
  const res = fsFetch_(':runQuery', { structuredQuery: {
    from: [{ collectionId: 'users' }],
    where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'employee' } } },
  } });
  const map = {};
  res.forEach(r => {
    if (!r.document) return;
    const f = r.document.fields || {};
    if (f.name) map[f.name.stringValue] = r.document.name.split('/').pop();
  });
  return map;
}

function fsFetch_(path, body) {
  const res = UrlFetchApp.fetch(FS + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ══ チャットワーク通知 ══
const ADMIN_URL = 'https://dubstock-host.github.io/kintai-dubstock/admin.html';
const LEAVE_LABELS = { '全日': '有給：全日', '午前半休': '有給：AM', '午後半休': '有給：PM', '振替休日': '振替休日', '時間休': '時間休' };

function notify_(p) {
  try {
    const n = String(p.n || '');
    const id = String(p.id || '');
    if (n === 'leave' || n === 'travel') {
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return { ok: false, error: 'bad request' };
      const col = n === 'leave' ? 'leaves' : 'travels';
      const d = fsGet_(col + '/' + id);
      if (!d) return { ok: false, error: 'not found' };
      // 出張報告は差し戻し→再提出があるので、「どの提出に対して通知したか」で判定する（端末の時計のずれに左右されない）
      const key = n === 'leave' ? 'leave' : String(d.submittedAt || '');
      if (d.notifiedAt && d.notifiedFor === key) return { ok: true, skipped: 'already' };
      if (n === 'leave' && d.notifiedAt) return { ok: true, skipped: 'already' };
      if (n === 'leave' && d.status !== 'pending') return { ok: true, skipped: 'status' };
      if (n === 'travel' && d.status !== 'pending') return { ok: true, skipped: 'status' };
      const body = n === 'leave' ? leaveMsg_(d) : travelMsg_(d);
      postChatwork_(body);
      fsPatch_(col + '/' + id, { notifiedAt: new Date().toISOString(), notifiedFor: key });
      return { ok: true };
    }
    if (n === 'remind') return remindOne_(String(p.uid || ''), String(p.ym || ''));
    if (n === 'expense') {
      const uid = String(p.uid || ''), ym = String(p.ym || '');
      if (!/^[A-Za-z0-9]{10,64}$/.test(uid) || !/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad request' };
      const items = fsQuery_('expenses', 'userId', uid).filter(x => String(x.date || '').slice(0, 7) === ym);
      if (!items.length || !items.every(x => x.submitted)) return { ok: true, skipped: 'not submitted' };
      const last = items.map(x => String(x.submittedAt || '')).sort().pop();
      const logId = 'expense_' + uid + '_' + ym;
      const log = fsGet_('notifyLog/' + logId);
      if (log && log.submittedAt === last) return { ok: true, skipped: 'already' };
      postChatwork_(expenseMsg_(items, ym));
      fsPatch_('notifyLog/' + logId, { submittedAt: last, notifiedAt: new Date().toISOString() });
      return { ok: true };
    }
    return { ok: false, error: 'bad request' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// 申請者が書いた文字にチャットワークの記法（[To:…] など）が混ざっても効かないようにする
function cw_(s) { return String(s == null ? '' : s).replace(/\[/g, '［').replace(/\]/g, '］'); }
function md_(s) { s = String(s || ''); return s ? s.slice(0, 4) + '/' + s.slice(5, 7) + '/' + s.slice(8, 10) : ''; }
function yen_(n) { return Number(n || 0).toLocaleString('ja-JP') + ' 円'; }

function leaveMsg_(d) {
  const lines = ['申請者：' + cw_(d.userName), '種別：' + cw_(LEAVE_LABELS[d.type] || d.type), '日付：' + md_(d.date)];
  if (d.type === '振替休日' && d.workDate) lines.push('振替元（出勤する休日）：' + md_(d.workDate));
  if (d.reason) lines.push('理由：' + cw_(d.reason));
  lines.push('', '承認はこちら：' + ADMIN_URL);
  return '[info][title]📅 休日申請が届きました（きん太）[/title]' + lines.join('\n') + '[/info]';
}

function expenseMsg_(items, ym) {
  const total = items.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const lines = ['申請者：' + cw_(items[0].userName), '対象月：' + ym.replace('-', '年') + '月', '件数：' + items.length + ' 件', '合計：' + yen_(total), ''];
  items.slice(0, 10).forEach(x => lines.push('・' + md_(x.date).slice(5) + '　' + cw_(x.desc) + '　' + yen_(x.amount)));
  if (items.length > 10) lines.push('ほか ' + (items.length - 10) + ' 件');
  lines.push('', '確認はこちら：' + ADMIN_URL);
  return '[info][title]💰 経費精算が提出されました（きん太）[/title]' + lines.join('\n') + '[/info]';
}

function travelMsg_(d) {
  const cost = (d.costs || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const lines = ['申請者：' + cw_(d.userName), '出張先：' + cw_(d.dest),
    '期間：' + md_(d.from) + (d.to && d.to !== d.from ? ' 〜 ' + md_(d.to) : '')];
  if (d.purpose) lines.push('目的：' + cw_(d.purpose));
  lines.push('費用：' + yen_(cost), '', '確認はこちら：' + ADMIN_URL);
  return '[info][title]✈ 出張報告が提出されました（きん太）[/title]' + lines.join('\n') + '[/info]';
}

function postChatwork_(body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('CHATWORK_TOKEN'), room = props.getProperty('CHATWORK_ROOM_ID');
  if (!token || !room) throw new Error('スクリプト プロパティに CHATWORK_TOKEN と CHATWORK_ROOM_ID を設定してください');
  const res = UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + encodeURIComponent(room) + '/messages', {
    method: 'post',
    headers: { 'X-ChatWorkToken': token },
    payload: { body: body },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Chatwork ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
}

// 手動確認用：テスト投稿を1件送る
function testChatwork() {
  postChatwork_('[info][title]🔔 きん太からのテスト通知[/title]この部屋に、休日申請・経費精算・出張報告の通知が届きます。[/info]');
  Logger.log('チャットワークに送信しました');
}

// ── Firestore REST（値の変換つき）──
function fromFs_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs_);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; Object.keys(f).forEach(k => o[k] = fromFs_(f[k])); return o; }
  return null;
}
function docToObj_(doc) { const o = {}; const f = doc.fields || {}; Object.keys(f).forEach(k => o[k] = fromFs_(f[k])); return o; }
function fsGet_(path) {
  const res = UrlFetchApp.fetch(FS + '/' + path, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() >= 300) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return docToObj_(JSON.parse(res.getContentText()));
}
function fsPatch_(path, obj) {
  const fields = {}; Object.keys(obj).forEach(k => fields[k] = { stringValue: String(obj[k]) });
  const mask = Object.keys(obj).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = UrlFetchApp.fetch(FS + '/' + path + '?' + mask, {
    method: 'patch', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
}
function fsQuery_(col, field, value) {
  const res = fsFetch_(':runQuery', { structuredQuery: {
    from: [{ collectionId: col }],
    where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
  } });
  return res.filter(r => r.document).map(r => docToObj_(r.document));
}

// ══ 月次の提出リマインド ══
const APP_URL = 'https://dubstock-host.github.io/kintai-dubstock/';
const DOW_ = ['日', '月', '火', '水', '木', '金', '土'];
const ymd_ = d => Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');

// hr-common.js から祝日・開始月・締めの営業日数を読む
function loadCommon_() {
  const src = UrlFetchApp.fetch(APP_URL + 'hr-common.js?v=' + Date.now()).getContentText();
  const block = src.slice(src.indexOf('HOLIDAYS'), src.indexOf(']);'));
  const holidays = new Set(block.match(/\d{4}-\d{2}-\d{2}/g) || []);
  const start = (src.match(/CLOSING_START_YM\s*=\s*"(\d{4}-\d{2})"/) || [])[1] || '9999-12';
  const days = Number((src.match(/CLOSE_BIZ_DAYS\s*=\s*(\d+)/) || [])[1] || 3);
  if (!holidays.size) throw new Error('hr-common.js から祝日を読めませんでした');
  return { holidays, start, days };
}
function isBiz_(d, C) { const w = d.getDay(); return w >= 1 && w <= 5 && !C.holidays.has(ymd_(d)); }
function prevYm_(today) { return Utilities.formatDate(new Date(today.getFullYear(), today.getMonth() - 1, 1), 'Asia/Tokyo', 'yyyy-MM'); }
function deadline_(ym, C) {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1); let n = 0;
  for (;;) { if (isBiz_(d, C) && ++n === C.days) return d; d.setDate(d.getDate() + 1); }
}
function fmtD_(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '（' + DOW_[d.getDay()] + '）'; }
// 今月の何営業日目か（今日が営業日でなければ 0）
function bizIndex_(today, C) {
  if (!isBiz_(today, C)) return 0;
  const d = new Date(today.getFullYear(), today.getMonth(), 1); let n = 0;
  while (ymd_(d) <= ymd_(today)) { if (isBiz_(d, C)) n++; d.setDate(d.getDate() + 1); }
  return n;
}

function employees_() {
  const res = fsFetch_(':runQuery', { structuredQuery: {
    from: [{ collectionId: 'users' }],
    where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'employee' } } },
  } });
  return res.filter(r => r.document).map(r => Object.assign(docToObj_(r.document), { uid: r.document.name.split('/').pop() }));
}
function todo_(c) { const t = []; if (!c || !c.kintaiAt) t.push('kintai'); if (!c || !c.expenseAt) t.push('expense'); return t; }

function remindMsg_(e, todo, ym, dl, urgent, byAdmin) {
  const mm = Number(ym.slice(5, 7)) + '月';
  const lines = ['[To:' + e.chatworkId + ']' + cw_(e.name) + 'さん'];
  lines.push(urgent
    ? '🔴【至急】' + mm + '分の提出期限（' + fmtD_(dl) + '）を過ぎています。今日中に提出してください。'
    : '📋 ' + mm + '分の提出をお願いします。期限は ' + fmtD_(dl) + ' です。');
  if (byAdmin) lines.push('（管理者からの催促です）');
  lines.push('');
  if (todo.indexOf('kintai') >= 0) lines.push('■ 勤怠の確定：きん太 →「月次」→ ' + mm + ' → 内容を確かめて「' + mm + 'の勤怠を確定する」');
  if (todo.indexOf('expense') >= 0) lines.push('■ 経費の確定：KEIHI →「経費精算」→ ' + mm + ' → 明細を確かめて「確定する」（立て替えがない月は「経費なしで確定」）');
  lines.push('', APP_URL);
  return lines.join('\n');
}

// 毎朝の自動実行
function dailyRemind() {
  const C = loadCommon_(), today = new Date();
  const idx = bizIndex_(today, C);
  if (!idx) { Logger.log('営業日ではないので送りません'); return; }
  const ym = prevYm_(today);
  if (ym < C.start) { Logger.log(ym + ' はリマインドの対象外（開始月 ' + C.start + '）'); return; }
  const dl = deadline_(ym, C), urgent = idx > C.days;
  const missing = [];
  employees_().filter(e => e.active === true && (!e.hireDate || String(e.hireDate).slice(0, 7) <= ym)).forEach(e => {
    const todo = todo_(fsGet_('closings/' + e.uid + '_' + ym));
    if (!todo.length) return;
    if (!e.chatworkId) { missing.push(e.name); return; }
    postChatwork_(remindMsg_(e, todo, ym, dl, urgent, false));
    Logger.log('送信：' + e.name + '（' + todo.join('・') + '）');
  });
  if (missing.length) Logger.log('チャットワークID未登録のため送れなかった人：' + missing.join('、'));
}

// 管理者画面の「催促する」
function remindOne_(uid, ym) {
  if (!/^[A-Za-z0-9]{10,64}$/.test(uid) || !/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad request' };
  const C = loadCommon_(), today = new Date();
  if (ym !== prevYm_(today) || ym < C.start) return { ok: true, skipped: '対象の月ではありません' };
  const dl = deadline_(ym, C);
  if (ymd_(today) <= ymd_(dl)) return { ok: true, skipped: 'まだ期限内です' };
  const e = employees_().filter(x => x.uid === uid)[0];
  if (!e || e.active !== true) return { ok: false, error: '社員が見つかりません' };
  if (!e.chatworkId) return { ok: true, skipped: 'チャットワークID未登録' };
  const todo = todo_(fsGet_('closings/' + uid + '_' + ym));
  if (!todo.length) return { ok: true, skipped: '提出済みです' };
  const log = fsGet_('remindLog/' + uid + '_' + ym);
  if (log && log.lastAt && Date.now() - new Date(log.lastAt).getTime() < 3600000) return { ok: true, skipped: 'recent' };
  postChatwork_(remindMsg_(e, todo, ym, dl, true, true));
  fsPatch_('remindLog/' + uid + '_' + ym, { lastAt: new Date().toISOString() });
  return { ok: true };
}

// 一度だけ実行：毎朝10時台に dailyRemind を動かす
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyRemind').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRemind').timeBased().atHour(10).everyDays(1).inTimezone('Asia/Tokyo').create();
  Logger.log('毎朝10時台に dailyRemind を実行する設定にしました');
}

// 確認用：送らずに、今日送られる内容をログに出す
function previewRemind() {
  const C = loadCommon_(), today = new Date(), ym = prevYm_(today);
  Logger.log('祝日 ' + C.holidays.size + ' 件／開始月 ' + C.start + '／締め 第' + C.days + '営業日');
  Logger.log('今日は今月の第' + bizIndex_(today, C) + '営業日（0は休日）。対象 ' + ym + '、期限 ' + fmtD_(deadline_(ym, C)));
  employees_().filter(e => e.active === true).forEach(e => {
    const todo = todo_(fsGet_('closings/' + e.uid + '_' + ym));
    Logger.log(e.name + '：' + (todo.length ? '未提出（' + todo.join('・') + '）' : '提出済み') + (e.chatworkId ? '' : '／チャットワークID未登録'));
  });
}
