# STEP 3：DB v2と履歴データ仕様

データベース名はstock-note、バージョンは2。既存products・stocksの主キー・インデックス・レコードは変更しない。新ストアを追加するだけで、既存データの補正や架空の履歴の生成は行わない。

## ストア

| ストア | 主キー | インデックス |
| --- | --- | --- |
| products（既存） | id | productCode（unique、既存維持） |
| stocks（既存） | productId | 変更なし |
| movements（追加） | id | productId、occurredAt、productIdOccurredAt（複合キー[productId, occurredAt]） |
| cancellations（追加） | id | movementId（unique）、cancelledAt |

## 入出庫履歴movements

| フィールド | 型と制約 |
| --- | --- |
| id | UUID文字列、一意 |
| productId | 実在する商品のUUID |
| type | INまたはOUT |
| quantity | 1以上の安全な整数 |
| stockBefore / stockAfter | 0以上の安全な整数。入庫はbefore＋quantity、出庫はbefore−quantity |
| stockVersionBefore / stockVersionAfter | 1以上の安全な整数。afterはbefore＋1 |
| productCodeSnapshot | 取引時コード、正規化済み半角英数字・_・-、1〜40文字。商品コードは変更不可のため現商品と一致 |
| productNameSnapshot | 取引時の商品名、前後空白除去済み1〜100文字。現商品名と異なってもよい |
| unitSnapshot | 取引時単位、前後空白除去済み1〜10文字。履歴のある商品は単位変更不可 |
| occurredAt | システム確定日時。UTCのISO文字列 |
| note | 任意入力。保存値は文字列（未入力は空文字）、前後空白除去済み0〜500文字 |
| actorId | 初期版はnull。将来は担当者UUID |

## 取消履歴cancellations

| フィールド | 型と制約 |
| --- | --- |
| id | UUID文字列、一意 |
| movementId | 元の入出庫履歴UUID。unique制約で取消最大1回 |
| productId | 元取引と同じ商品のUUID |
| stockBefore / stockAfter | 0以上の安全な整数。入庫取消はbefore−元数量、出庫取消はbefore＋元数量 |
| stockVersionBefore / stockVersionAfter | 1以上の安全な整数。afterはbefore＋1 |
| reason | 前後空白除去済み1〜500文字の必須理由 |
| cancelledAt | システム確定日時。元取引以降のUTCのISO文字列 |
| actorId | 初期版はnull。将来は担当者UUID |

## 共通検証

HistoryValidation.validateは商品・在庫の基本形式をInventoryDB.validateSnapshotで検証した後に呼ぶ。単体でも履歴の型・形式・計算・参照・連鎖を検証し、不整合はInventoryErrorのDATAとして返す。入力配列・レコードを書き換えず、件数だけを返す。

- 商品ごとに入出庫と取消をまとめ、stockVersionAfterで並べる。初期在庫0・初期stockVersion 1から、前後在庫・前後versionが連続することを確認。
- イベントの日時は商品の作成以降、version順で非減少。同一ミリ秒の複数処理を許し、順序はversionで確定する。
- 取消は元取引より後の在庫versionで、日時も元取引以降。全量取消のみ。元取引を編集・削除しない。
- 最後の在庫数・version・日時が現在のstocksと一致しなければ不整合。
- 履歴なし商品は在庫0かつstock.versionが数値の1の場合のみ正常とする。初回入出庫はversion 1→2、以後は入出庫・取消ごとに1増える。履歴なしのversionが1以外、または在庫非0は不整合として停止する。既存レコードの在庫version・更新日時は自動補正しない。
- 商品参照・取消参照・重複ID・二重取消・負在庫・安全整数の上限超過・削除後の取引を拒否。
- 商品の論理削除自体は未実装だが、削除済みの現在庫0と履歴の整合性は検証する。
- 一度でも実履歴がある商品は、全件取消後もhasMovementsがtrue。既存商品編集APIも同じreadwriteトランザクションでこの判定を行い、単位の変更を拒否する。

## 移行と失敗

onupgradeneededのoldVersionに応じてv1の既存ストア作成とv2の追加を順に行う。初回作成はv2の4ストア、v1からの更新は新2ストアのみ。例外時はversionchangeトランザクションをabortし、DBバージョン・既存レコード・インデックスを保持する。不正データを見つけてもDBを初期化しない。

デモ配列はこの検証やDBに渡さない。通常モードの商品読み取り・登録・編集時は、4ストアを同じトランザクションで読んで整合性を検証する。

## 次段階

STEP 3-1完了時点では履歴書き込みAPI・実在庫更新・履歴検索画面は未実装だった。STEP 3-2で入出庫保存、STEP 3-3で取消保存と対象選択用の最小限の履歴表示を実装済み。STEP 3-4で通常モードの履歴検索・詳細画面を実装。書き込みAPIでは数量・備考・取消理由を正規化・検証し、システム日時だけを採用する。利用者から過去日時を受け付けない。検証は保存済み日時の形式と順序を確かめるもので、過去に保存された正しい記録を現在時刻との比較で拒否するものではない。
入出庫では在庫更新＋movements追加、取消では在庫更新＋cancellations追加を同じreadwriteトランザクションで行い、complete後のみ成功を返す。


## STEP 3-2の保存API

`postMovement`は操作IDをmovements.idとして使う。同じID・同じ正規化済み数量／備考・商品／種別なら保存済み取引を返し、再更新しない。異内容でのID再利用は拒否する。最新商品versionを確認し、最新在庫から計算する。4ストアを同一readwriteトランザクションで読み取り、stocks更新とmovements追加のみを書き込む。日時はシステムUTC（直前の在庫更新日時以上）、actorIdはnull。取消の実保存はSTEP 3-3で実装。


## STEP 3-3の取消API

`cancelMovement({movementId,operationId,reason},{mode:'normal'})`は4ストアを含む1つのreadwriteトランザクションで整合性を検証する。現在の商品・最新在庫・元取引・既存取消を確認し、元取引の数量を全量反転する。利用者による数量・取消日時の指定は禁止。理由は前後空白除去後1〜500文字必須。負在庫・安全整数上限超過・削除済み商品は拒否する。

stocksのquantity・version・updatedAtを更新し、cancellationsへ操作IDを主キーとして追加する。元のmovementsは変更しない。movementIdのunique索引とトランザクション内の既存取消確認で二重取消を防ぐ。同じ操作ID・元取引・正規化後理由の再送は処理済み結果を返す。異内容のID再利用や別IDでの再取消は拒否する。同時取消と入出庫は同一ストアを含むトランザクションによって順に実行され、最新在庫から判定する。complete後だけ成功とし、abort時は両方の書き込みを取り消す。

通常モードの取消対象表示は、商品・在庫・入出庫・取消を同じreadonlyトランザクションで読み取った検証済みスナップショットを利用する。商品名・コード・単位は取引時の値で表示する。STEP 3-4で履歴検索・詳細画面を追加。


## STEP 3-4：履歴検索・表示

DBのスキーマ・保存形式は変更しない。readProducts({includeHistory:true})の検証済みスナップショットから、movementsを元取引として表示しcancellationsをmovementIdで関連付ける。商品名・単位は現在の商品ではなく取引時スナップショットを表示する。検索はエスケープ前の文字列で行い、HTML出力だけをエスケープする。

検索日はAsia/Tokyoの入出庫日。開始日0時以上、終了日の翌日0時未満とし、DBのUTC値は変更しない。実在日・形式・開始終了順序を検証する。取消状態は取消レコードの存在で判定する。並び順はoccurredAt降順、同時刻はproductId昇順・stockVersionAfter降順・id昇順。1ページ50件。条件変更は1ページ目へ戻す。条件とページは同じモードの画面移動・通知・bfcache復帰時に保持し、モード切替時は初期化する。

履歴詳細は#movement/<movementId>、商品指定検索は#history/product/<productId>。直接編集・削除のUI/APIは追加しない。DB読み込み失敗時は一覧・詳細の表示をエラー画面に切り替え、検索0件と区別する。不正データは修正しない。取消理由を保持するダイアログは一覧のDOMとは独立している。
