# userId → Firebase Auth UID 移行 手順書

独自ID `yuuki_kenta` を Firebase Auth の UID に置き換え、Firestore セキュリティルールで
アクセス制御を有効にするための作業手順です。

---

## ⚠️ 実行順序について

**この順序を守ってください。** 前後させると本番が停止します。

| | 作業 | 理由 |
|---|---|---|
| 0 | バックアップ | 取得済み → `~/kintai-dubstock-backup/` |
| 1 | **新コードを push（本番反映）** | 先に出すことで、未移行の状態ではログインが拒否される＝**孤児データが作られない** |
| 2 | 移行ツールを実行 | ルール適用前でないとツール自身が `users` に書き込めない |
| 3 | 動作確認 | |
| 4 | firestore.rules を適用 | 新コードが本番に出る前に適用すると、旧コードの全件取得が全て拒否される |
| 5 | 再度動作確認 | |
| 6 | `tools/` を削除して push | 移行ツールを公開したままにしない |

**手順1〜2の間は誰もログインできません**（「このアカウントは登録されていません」と表示されます）。
これは意図した挙動です。逆順（移行を先）にすると旧コードがログインを通してしまい、
そこで打刻すると `userId:"yuuki_kenta"` の孤児データが再生成されるため、この順序にしています。

**手順1で中断した場合**は、データが未移行のままなので `git revert` + push で完全に元に戻ります。

---

## 0. バックアップ（取得済み）

```
~/kintai-dubstock-backup/20260922-144530/
  kintai.json    117件
  leaves.json      1件
  expenses.json   57件
  travels.json     1件
```

Firestore REST API の形式そのままです。個人情報を含むため、リポジトリには入れないでください。

---

## 1. 新コードを push する（本番反映）

```bash
cd /Users/seiya/kintai-dubstock && git push
```

この時点でアプリはログインを拒否するようになります（データが未移行のため）。**意図した挙動です。**

---

## 2. 移行ツールを実行する

ローカルサーバを起動し、ブラウザで開きます（`localhost` は Firebase の既定の許可ドメインです）。

```bash
cd /Users/seiya/kintai-dubstock && python3 -m http.server 5182
```

→ http://localhost:5182/tools/migrate-to-authuid.html

### 2-a. 管理者アカウントを登録する

1. `account@dubstock.co.jp` でログイン
2. フォームに入力
   - 氏名：`谷口`（実際の表示名）
   - 権限：**admin**
   - 旧 userId：**空欄のまま**（管理者は移行対象データを持たないため）
   - 入社日：任意
3. 「ドライラン」→ 内容を確認 → 「この内容で実行する」
4. ログアウト

### 2-b. 従業員アカウントを登録し、データを移行する

1. `yuki.k@dubstock.co.jp` でログイン
2. フォームに入力
   - 氏名：`結城 健太`
   - 権限：**employee**
   - 旧 userId：`yuuki_kenta`
   - 入社日：`2025-09-01`
3. 「ドライラン」を押し、**以下が表示されることを確認**
   ```
   kintai      117 件
   leaves        1 件
   expenses     57 件
   travels       1 件
   実行される操作: 新規書き込み 117 / フィールド更新 59 / 旧ドキュメント削除 117（合計 293）
   ```
   件数が違う場合は実行せず、原因を確認してください。
4. 「この内容で実行する」
5. 完了後、`旧 userId "yuuki_kenta" のドキュメントは 0 件になりました。` を確認

> このツールは冪等です。途中で失敗した場合はドライランからやり直せます。
> 書き込みはバッチ単位で原子的に行われるため、中断してもデータは失われません。

---

## 3. 動作確認

（手順1の push は完了済み。GitHub Pages への反映に 1 分程度かかります）

反映後：

- https://dubstock-host.github.io/kintai-dubstock/ に結城さんでログイン → 打刻・月次・有給が表示されるか
- https://dubstock-host.github.io/kintai-dubstock/keihitsu.html → 経費一覧・出張報告が表示されるか
- https://dubstock-host.github.io/kintai-dubstock/admin.html に管理者でログイン → 全社員概要に結城さんのカードが出るか

---

## 4. セキュリティルールを適用する

Firebase コンソール → Firestore Database → **ルール** タブ
→ `firestore.rules` の内容を全て貼り付け → **公開**

---

## 5. 適用後の確認

> **エミュレータによるルールの事前テストは実施していません。**
> ルールの構文エラーは Firebase コンソールが公開前に弾きますが、
> **意味の誤り（許可すべきものを拒否する等）は実機でしか分かりません。**
> 下記 5-b を上から順に消化してください。上のほうが失敗しやすい項目です。

### 5-a. 未認証アクセスが遮断されたか（機械的に判定できる）

```bash
bash tools/verify-rules.sh
```

- **6件すべて PASS になれば成功**（未認証では何も読めない状態）
- FAIL が残る場合はルールが公開されていません
- 適用前に実行すると全件 FAIL になります（＝現状が全開放であることの確認になります）

### 5-b. アプリが正常に動くか（リスクの高い順）

ブラウザの開発者ツールを開いて実施してください。ルール起因の失敗は
コンソールに `Missing or insufficient permissions` と出ます。

| # | 操作 | 検証しているルール | 失敗したら見る箇所 |
|---|---|---|---|
| 1 | 従業員で**月次タブ**を開く | `kintai` の `list` とクエリ解析の整合 | `allow list` と `isMine()`（`isMine()` にキー存在確認を足すと壊れる） |
| 2 | **打刻していない日**を表示（朝イチの打刻タブ） | `kintai` の `get` で `resource == null` を許容できているか | `kintai` の `allow get` |
| 3 | **出勤**を押す | `create` の `docId == uid + '_' + date` | `kintai` の `allow create` |
| 4 | **退勤**を押す／打刻を取り消す | `update` / `delete` | `kintai` の `allow update` `allow delete` |
| 5 | 打刻修正で**出勤のみ**を保存 | `update` ＋ B-3 修正の確認 | `kintai` の `allow update` |
| 6 | **経費タブ**を開く | `expenses` の `list` | `expenses` の `allow list` |
| 7 | 経費を追加 → 編集 → 月次提出 | `create`（`noApprovalFields`）／`update`（`approvalUnchanged`）| `expenses` の `allow create` `allow update` |
| 8 | 有給を申請 → 取消 | `create`（`status=='pending'`）／`delete`（pending 限定）| `leaves` |
| 9 | **既存の出張報告を開いて編集し保存** | `travels` の `update` ＋ B-2 修正の確認 | `travels` の `allow update` |
| 10 | 管理者で**全社員概要**を開く | `isAdmin()` が `users/{uid}` から解決できるか | `isAdmin()` と `users` の `allow get` |
| 11 | 管理者で有給を承認／経費を承認／出張を承認 | 管理者のみの `update` | 各コレクションの `allow update` |
| 12 | 管理者で CSV 出力 | `kintai` の `list`（管理者経路）| `kintai` の `allow list` |
| 13 | **従業員アカウントで admin.html を開く** | 管理者画面が弾かれること | admin.html の role 判定 |

1〜2 が最も失敗しやすい箇所です。ここが通れば残りはほぼ通ります。

---

## 6. 移行ツールを削除する

```bash
cd /Users/seiya/kintai-dubstock && git rm -r tools && git commit -m "移行ツールを削除" && git push
```

---

## 社員を追加するとき（ルール適用後）

`users` への書き込みは管理者のみに制限されるため、**新しい社員が自分で移行ツールを実行することはできません**。
管理者が Firebase コンソールで `users/<新しい社員の Auth UID>` を作成してください。

```
name         : 山田 太郎
role         : employee
active       : true            (boolean)
hireDate     : 2026-04-01      (string)
avatar       : 山              (任意)
```

UID は Firebase コンソール → Authentication → Users で確認できます。
`hireDate` は有給付与日数の計算に使われるため**必ず設定してください**（未設定だと既定値が使われ、付与日数を誤ります）。

退職時は `active` を `false` にします。ログインが即座に遮断され、管理画面の社員名には「（退職）」が付きますが、
過去の勤怠・経費データは管理者から引き続き閲覧できます。

---

## 切り戻し

### ルールだけ戻す（数秒で完了・まずこれ）

アプリが動かなくなった場合、Firebase コンソール → Firestore → ルール に
**以下をそのまま貼って公開**すれば即座に元の状態に戻ります。データには影響しません。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> これは移行前と同じ全開放状態です。**復旧確認のための一時措置**であり、
> 原因を直したら必ずルールを再適用してください。

### コードを戻す

```bash
cd /Users/seiya/kintai-dubstock && git revert HEAD && git push
```

ただし**データは移行済み（userId が Auth UID）なので、旧コードに戻すとデータを見失います。**
コードを戻す場合は、上のルール全開放と合わせて、移行ツールで逆向き移行
（旧 userId に新UIDを指定）を実行するか、バックアップ JSON から復元してください。

### データを戻す

`~/kintai-dubstock-backup/20260922-144530/` の JSON は Firestore REST API の形式そのままです。
復元スクリプトが必要な場合は用意します（ルールを全開放にした状態でのみ実行可能）。

---

## 今回の変更で残っている課題

以下は**今回対応していません**（別途対応が必要）。

- **C-1** 出勤日数が従業員月次・管理者勤怠・概要カードで食い違う（有給日・退勤未打刻日の扱いが3画面で異なる）
- **C-2** 有給残日数：振替休日を年休として消化計上／時間休が一律0.25日／失効付与分の控除が残り続ける／残日数・重複日チェックなし
- **C-3** 固定休憩12:00〜13:00 と重ならない勤務は休憩0分になる
- **C-4** 1日2シフト（中抜け）が扱えない
- **C-5** 打刻修正に上限チェックがない（退勤<出勤で自動的に翌日扱い）
- **C-6** GAS同期が片道・打刻取消が反映されない・失敗を握り潰す
- **C-7** 有給の取り消しが物理削除（`cancelled` ステータスが未使用）
- **A-3** 保存データが未エスケープで `innerHTML` に渡る（XSS）
- **A-4** `import-march-expense.html` が公開状態（3月分は投入済みのため削除推奨）
- **D-2** オフライン時の打刻がリトライされない
- **D-3** 祝日リストが 2026-11-23 までしかない（2027年分の追加が必要）
- 経費モーダルで `payee` 未設定時に `undefined` と表示される
- 経費の日付初期値が UTC 基準（日本時間の朝9時前は前日になる）
