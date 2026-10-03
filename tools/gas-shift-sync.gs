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
