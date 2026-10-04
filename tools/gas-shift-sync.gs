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
