/**
 * きん太：Googleカレンダーのシフト → Firestore shifts コレクションへの同期（下書き）
 *
 * 動かし方
 *  1. シフトのカレンダーを読めて、かつ Firebase プロジェクト kintai-dubstock に
 *     権限のある Google アカウントで、新しい Apps Script プロジェクトを作る
 *  2. このファイルを貼り付け、appsscript.json に下の oauthScopes を書く
 *  3. CONFIG の CALENDAR_ID と NAME_KEYWORDS を埋める
 *  4. syncShifts を一度手で実行して許可 → installTrigger を一度実行（15分ごとに自動同期）
 *
 * appsscript.json
 *  "oauthScopes": [
 *    "https://www.googleapis.com/auth/calendar.readonly",
 *    "https://www.googleapis.com/auth/datastore",
 *    "https://www.googleapis.com/auth/script.external_request",
 *    "https://www.googleapis.com/auth/script.scriptapp"
 *  ]
 *
 * 仕組み
 *  - 予定のタイトルにキーワード（例：「山下」）が含まれていれば、その人のシフトとみなす
 *  - 終日の予定は無視する
 *  - 同期する期間（先月1日〜再来月末）の shifts を毎回作り直す。
 *    カレンダーから消した予定は、きん太からも消える
 *  - Firestore へは OAuth トークンで REST を呼ぶので、セキュリティルールを通らずに書ける
 */

const CONFIG = {
  PROJECT_ID: 'kintai-dubstock',
  CALENDAR_ID: '',                 // 例：xxxxx@group.calendar.google.com（カレンダー共有後に記入）
  NAME_KEYWORDS: {                 // 予定タイトルのキーワード → きん太の氏名（users.name と一致させる）
    // '山下': '山下枝里子',
  },
};

const FS = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents';

function syncShifts() {
  if (!CONFIG.CALENDAR_ID) throw new Error('CONFIG.CALENDAR_ID を入れてください');
  const uidByName = loadEmployeeUids_();
  const keywordToUid = {};
  Object.keys(CONFIG.NAME_KEYWORDS).forEach(k => {
    const uid = uidByName[CONFIG.NAME_KEYWORDS[k]];
    if (!uid) throw new Error('きん太に「' + CONFIG.NAME_KEYWORDS[k] + '」さんが見つかりません');
    keywordToUid[k] = uid;
  });

  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) throw new Error('カレンダーを開けません（共有されているか確認）');

  // uid → date → items
  const plan = {};
  cal.getEvents(from, to).forEach(ev => {
    if (ev.isAllDayEvent()) return;
    const title = ev.getTitle() || '';
    Object.keys(keywordToUid).forEach(k => {
      if (title.indexOf(k) < 0) return;
      const uid = keywordToUid[k];
      const s = ev.getStartTime(), e = ev.getEndTime();
      // 深夜0〜5時の予定は前日の勤務として扱う（きん太の勤務日の区切りと同じ）
      const wd = new Date(s.getTime()); if (wd.getHours() < 5) wd.setDate(wd.getDate() - 1);
      const date = Utilities.formatDate(wd, 'Asia/Tokyo', 'yyyy-MM-dd');
      plan[uid] = plan[uid] || {};
      (plan[uid][date] = plan[uid][date] || []).push({
        start: Utilities.formatDate(s, 'Asia/Tokyo', 'HH:mm'),
        end: Utilities.formatDate(e, 'Asia/Tokyo', 'HH:mm'),
        title: title,
      });
    });
  });

  // 期間内の全日付について、予定があれば上書き、無ければ削除
  const writes = [];
  const stamp = new Date().toISOString();
  Object.keys(keywordToUid).map(k => keywordToUid[k]).filter((u, i, a) => a.indexOf(u) === i).forEach(uid => {
    for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
      const date = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
      const name = 'projects/' + CONFIG.PROJECT_ID + '/databases/(default)/documents/shifts/' + uid + '_' + date;
      const items = plan[uid] && plan[uid][date];
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
  });

  // commit は 1 回 500 件まで
  for (let i = 0; i < writes.length; i += 450) {
    fsFetch_(':commit', { writes: writes.slice(i, i + 450) });
  }
  Logger.log('同期しました：書き込み ' + writes.length + ' 件');
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
  if (res.getResponseCode() >= 300) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
  return JSON.parse(res.getContentText());
}

function installTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncShifts').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncShifts').timeBased().everyMinutes(15).create();
}
