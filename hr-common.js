// ══════════════════════════════════════════════════════════════
//  きん太 共通：祝日・営業日・月次の締め（勤怠確定・経費確定）
//  index.html / keihitsu.html / admin.html が import し、
//  GAS（tools/gas-shift-sync.gs）もこのファイルから祝日を読み取る。
// ══════════════════════════════════════════════════════════════

// 国民の祝日・休日（振替休日・国民の休日を含む）
// 出典: 内閣府「国民の祝日について」の公開CSV
//       https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
// 取得日: 2026-09-22 ／ 収録範囲: 1955〜2027年
//
// ※ 内閣府CSVは毎年更新される。2028年分が公表されたらここに追記する（ここ1か所だけでよい）。
//    未登録の年は祝日が平日扱いになり、未打刻の判定や提出期限がずれる。
export const HOLIDAYS=new Set([
  // 2025年（入社後）
  "2025-09-15","2025-09-23","2025-10-13","2025-11-03","2025-11-23","2025-11-24",
  // 2026年
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20","2026-04-29",
  "2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-07-20","2026-08-11",
  "2026-09-21","2026-09-22","2026-09-23","2026-10-12","2026-11-03","2026-11-23",
  // 2027年
  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-21","2027-03-22",
  "2027-04-29","2027-05-03","2027-05-04","2027-05-05","2027-07-19","2027-08-11",
  "2027-09-20","2027-09-23","2027-10-11","2027-11-03","2027-11-23",
]);

const p2=n=>String(n).padStart(2,"0");
export const ymd=d=>d.getFullYear()+"-"+p2(d.getMonth()+1)+"-"+p2(d.getDate());
export const ymOf=d=>d.getFullYear()+"-"+p2(d.getMonth()+1);
const DOW=["日","月","火","水","木","金","土"];

// 営業日＝土日・祝日以外
export function isBizDay(d){const w=d.getDay();return w>=1&&w<=5&&!HOLIDAYS.has(ymd(d));}

// 締め（勤怠確定・経費確定・リマインド）を始める月。これより前の月は従来どおり（案内も通知も出さない）
export const CLOSING_START_YM="2026-10";
export const closingApplies=ym=>ym>=CLOSING_START_YM;

// 提出の締め：対象月の翌月の第3営業日まで
export const CLOSE_BIZ_DAYS=3;
export function closingDeadline(ym){
  const [y,m]=ym.split("-").map(Number);
  const d=new Date(y,m,1);let n=0;               // 翌月1日から数える
  for(;;){if(isBizDay(d)&&++n===CLOSE_BIZ_DAYS)return d;d.setDate(d.getDate()+1);}
}
export const fmtDeadline=d=>(d.getMonth()+1)+"/"+d.getDate()+"（"+DOW[d.getDay()]+"）";
export function prevYm(today=new Date()){return ymOf(new Date(today.getFullYear(),today.getMonth()-1,1));}
// 対象月が終わっているか（その月の勤怠・経費は、月が終わってから確定できる）
export function monthEnded(ym,today=new Date()){return ym<ymOf(today);}
// 期限を過ぎたか（期限日の翌日から）
export function isOverdue(ym,today=new Date()){return ymd(today)>ymd(closingDeadline(ym));}
export const ymLabel=ym=>Number(ym.slice(5,7))+"月";

// 締めの状態：closings/{uid}_{ym} = {userId, ym, kintaiAt?, expenseAt?, expenseNone?}
export function closingTodo(c){
  const t=[];
  if(!c||!c.kintaiAt)t.push("kintai");
  if(!c||!c.expenseAt)t.push("expense");
  return t;
}

// 社員画面の上に出す「やること」の案内（勤怠画面・経費画面で共通）
export function closingBannerHTML(ym,c,today=new Date()){
  const todo=closingTodo(c);
  if(!todo.length)return "";
  const over=isOverdue(ym,today),dl=fmtDeadline(closingDeadline(ym)),mm=ymLabel(ym);
  const row=(key,label,how)=>"<div class=\"cl-row\"><span class=\"cl-st "+(todo.includes(key)?"cl-todo\">未":"cl-done\">済")+"</span>"
    +"<div class=\"cl-body\"><b>"+label+"</b><div class=\"cl-how\">"+how+"</div></div>"
    +(todo.includes(key)?"<button class=\"cl-go\" data-cl=\""+key+"\">開く ›</button>":"")+"</div>";
  return "<div class=\"cl-banner"+(over?" cl-over":"")+"\">"
    +"<div class=\"cl-title\">"+(over?"🔴 至急：":"📋 ")+mm+"分の提出"+(over?"の期限（"+dl+"）を過ぎています":"をお願いします（期限 "+dl+"）")+"</div>"
    +row("kintai",mm+"の勤怠を確定","KINTAI →「月次」→ "+mm+" →「勤怠を確定する」")
    +row("expense",mm+"の経費を確定","KEIHI →「経費精算」→ "+mm+" →「確定する」（経費がない月は「経費なしで確定」）")
    +"</div>";
}
export const CLOSING_CSS=`
.cl-banner{background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:14px 16px;margin-bottom:16px;}
.cl-banner.cl-over{background:#FEF2F2;border-color:#FCA5A5;}
.cl-title{font-weight:700;font-size:14px;margin-bottom:8px;}
.cl-over .cl-title{color:#B91C1C;}
.cl-row{display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid rgba(0,0,0,.06);}
.cl-st{font-size:11px;font-weight:700;border-radius:4px;padding:2px 7px;flex-shrink:0;}
.cl-todo{background:#FEE2E2;color:#B91C1C;}.cl-done{background:#DCFCE7;color:#166534;}
.cl-body{flex:1;font-size:13px;min-width:0;}
.cl-how{font-size:11px;color:#64748B;margin-top:1px;}
.cl-go{background:#2563EB;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;}
.cl-lock{display:flex;gap:8px;align-items:center;background:#F0FDF4;border:1px solid #BBF7D0;color:#166534;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:12px;}
.cl-confirm{background:#fff;border:1px solid #BFDBFE;border-radius:12px;padding:14px 16px;margin-bottom:12px;}
.cl-confirm .cl-btn{background:#2563EB;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;margin-top:8px;}
.cl-warn{font-size:12px;color:#B45309;margin-top:4px;line-height:1.6;}
`;

// ── 振り返り（パートの業務内容）の表示 ──
// 項目は shifts[0].workReflect={done,good,next}。古い記録は workNote の全文から
// 「気づき：」「次回：」で始まる行を手がかりに分ける
export function reflectParts(sh){
  if(!sh)return null;
  if(sh.workReflect&&(sh.workReflect.done||sh.workReflect.good||sh.workReflect.next))
    return {done:sh.workReflect.done||"",good:sh.workReflect.good||"",next:sh.workReflect.next||""};
  if(!sh.workNote)return null;
  const r={done:[],good:[],next:[]};let cur="done";
  String(sh.workNote).split("\n").forEach(l=>{
    if(/^気づき：/.test(l)){cur="good";l=l.replace(/^気づき：/,"");}
    else if(/^次回：/.test(l)){cur="next";l=l.replace(/^次回：/,"");}
    r[cur].push(l);
  });
  return {done:r.done.join("\n").trim(),good:r.good.join("\n").trim(),next:r.next.join("\n").trim()};
}
const escH=v=>String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// collapsible=true のときは折りたたみ（閉じた状態で「やったこと」の1行目だけを見せる）
export function reflectHTML(sh,collapsible){
  const p=reflectParts(sh);if(!p)return "";
  const sec=(cls,label,t)=>t?"<div class=\"rf-sec\"><span class=\"rf-lb "+cls+"\">"+label+"</span><div class=\"rf-tx\">"+escH(t)+"</div></div>":"";
  const body=sec("rf-done","やったこと",p.done)+sec("rf-good","気づき",p.good)+sec("rf-next","次回",p.next);
  if(!collapsible)return "<div class=\"rf\">"+body+"</div>";
  const first=(p.done||p.good||p.next).split("\n")[0];
  const tags=[p.good?"<span class=\"rf-chip rf-good\">気づき</span>":"",p.next?"<span class=\"rf-chip rf-next\">次回</span>":""].join("");
  return "<details class=\"rf rf-d\"><summary><span class=\"rf-arrow\">▸</span><span class=\"rf-sum\">"+escH(first)+"</span>"+tags+"</summary>"+body+"</details>";
}
export const REFLECT_CSS=`
.rf{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:8px 10px;font-family:"Noto Sans JP",sans-serif;}
.rf-sec{display:flex;gap:8px;align-items:flex-start;padding:4px 0;}
.rf-sec+.rf-sec{border-top:1px dashed #E2E8F0;}
.rf-lb{flex-shrink:0;width:64px;text-align:center;font-size:10.5px;font-weight:700;border-radius:4px;padding:2px 0;margin-top:1px;}
.rf-done{background:#DBEAFE;color:#1D4ED8;}.rf-good{background:#DCFCE7;color:#166534;}.rf-next{background:#FEF3C7;color:#92400E;}
.rf-tx{flex:1;min-width:0;font-size:12px;line-height:1.65;color:#1E293B;white-space:pre-line;word-break:break-word;}
.rf-d summary{list-style:none;display:flex;gap:6px;align-items:center;cursor:pointer;font-size:12px;color:#1E293B;}
.rf-d summary::-webkit-details-marker{display:none;}
.rf-arrow{color:#94A3B8;font-size:11px;transition:transform .15s;}
.rf-d[open] .rf-arrow{transform:rotate(90deg);}
.rf-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rf-d[open] .rf-sum{white-space:normal;color:#64748B;}
.rf-chip{flex-shrink:0;font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;}
.rf-d[open] summary{margin-bottom:6px;}
.rf-tools{margin:0 0 8px;}
.rf-note{font-size:11.5px;line-height:1.7;color:#475569;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:8px 12px;margin-bottom:6px;}
.rf-btns{display:flex;justify-content:flex-end;gap:6px;}
.rf-tools button{background:#fff;border:1px solid #CBD5E1;color:#475569;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;}
`;
