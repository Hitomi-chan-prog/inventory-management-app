'use strict';

// DB接続・商品登録／編集・入出庫・取消を担当。履歴検索・詳細表示はapp.jsとhistory-query.jsが担当。
const InventoryDB = (() => {
  const NAME = 'stock-note';
  const VERSION = 2;
  let connection = null;
  let opening = null;
  let generation = 0;
  const listeners = new Set();
  const notify = message => listeners.forEach(listener => listener(message));
  // 文面ではなくcodeで画面側が対応を判断します。
  const failure = (message, code = 'STORAGE') => Object.assign(new Error(message), { name:'InventoryError', code });
  const isReliabilityError = error => !['INPUT','MODE','DUPLICATE','CONFLICT','NOT_FOUND'].includes(error?.code);

  function close() {
    generation++;
    if (connection) connection.close();
    connection = null;
    // 進行中のopenはキャンセルできないため、世代番号で遅い成功を破棄します。
    opening = null;
  }
  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const current = generation;
    const pending = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = (message, code = 'CONNECTION') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(failure(message, code));
      };
      const timer = setTimeout(() => fail('データベースへの接続がタイムアウトしました。他のタブを閉じて再試行してください。'), 8000);
      try {
        if (!globalThis.indexedDB) throw failure('unsupported');
        request = indexedDB.open(NAME, VERSION);
      } catch {
        fail('データベースを開けません。ブラウザの保存設定を確認してください。');
        return;
      }
      request.onupgradeneeded = event => {
        if (settled || current !== generation) { request.transaction.abort(); return; }
        try {
          // バージョンごとの変更を追加します。既存ストアを削除・再作成しません。
          if (event.oldVersion < 1) {
            const products = request.result.createObjectStore('products', { keyPath:'id' });
            products.createIndex('productCode', 'productCode', { unique:true });
            request.result.createObjectStore('stocks', { keyPath:'productId' });
          }
          if (event.oldVersion < 2) {
            const movements = request.result.createObjectStore('movements', {keyPath:'id'});
            movements.createIndex('productId','productId');
            movements.createIndex('occurredAt','occurredAt');
            movements.createIndex('productIdOccurredAt',['productId','occurredAt']);
            const cancellations = request.result.createObjectStore('cancellations',{keyPath:'id'});
            cancellations.createIndex('movementId','movementId',{unique:true});
            cancellations.createIndex('cancelledAt','cancelledAt');
          }
        } catch {
          request.transaction.abort();
          fail('データベースの更新に失敗しました。既存データは変更していません。', 'SCHEMA');
        }
      };
      request.onblocked = () => {
        if (!settled && current === generation) notify('データベースの更新待ちです。他のタブを閉じてください。');
      };
      request.onerror = () => fail('データベースを開けません。保存設定やアプリのバージョンを確認してください。');
      request.onsuccess = () => {
        const db = request.result;
        if (settled || current !== generation) {
          db.close();
          fail('接続を中止しました。再試行してください。');
          return;
        }
        try {
          const tx = db.transaction(['products','stocks','movements','cancellations'], 'readonly');
          const p = tx.objectStore('products');
          const index = p.index('productCode');
          if (p.keyPath !== 'id' || p.autoIncrement || index.keyPath !== 'productCode' || !index.unique || index.multiEntry || tx.objectStore('stocks').keyPath !== 'productId' || tx.objectStore('stocks').autoIncrement) throw failure('schema');
          for (const [storeName,indexes] of [['movements',[['productId','productId',false],['occurredAt','occurredAt',false],['productIdOccurredAt',['productId','occurredAt'],false]]],['cancellations',[['movementId','movementId',true],['cancelledAt','cancelledAt',false]]]]) {
            const store = tx.objectStore(storeName);
            if (store.keyPath !== 'id' || store.autoIncrement) throw failure('schema');
            for (const [name,key,unique] of indexes) { const i=store.index(name); if(JSON.stringify(i.keyPath)!==JSON.stringify(key)||i.unique!==unique||i.multiEntry) throw failure('schema'); }
          }
        } catch {
          db.close();
          fail('データベースの構造が不正です。データを削除せず、管理者に確認してください。', 'SCHEMA');
          return;
        }
        db.onversionchange = () => {
          close();
          notify('別のタブがデータベースを更新しています。接続を閉じました。画面を再読み込みしてください。');
        };
        db.onclose = () => {
          if (connection === db) {
            close();
            notify('データベースへの接続が切断されました。再試行してください。');
          }
        };
        connection = db;
        settled = true;
        clearTimeout(timer);
        resolve(db);
      };
    });
    opening = pending;
    // 古い接続の完了が、新しい接続のPromiseを消さないようにします。
    pending.then(() => { if (opening === pending) opening = null; }, () => { if (opening === pending) opening = null; });
    return pending;
  }
  const integer = (value, minimum) => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
  const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  function validateSnapshot(products, stocks, movements = [], cancellations = []) {
    const bad = () => { throw failure('保存データの型・範囲・関連が不正です。一覧は表示できません。データは変更していません。', 'DATA'); };
    const stockMap = new Map();
    for (const stock of stocks) {
      if (!stock || !id(stock.productId) || !integer(stock.quantity, 0) || !integer(stock.version, 1) || !date(stock.updatedAt) || stockMap.has(stock.productId)) bad();
      stockMap.set(stock.productId, stock);
    }
    const ids = new Set();
    const codes = new Set();
    const result = [];
    for (const p of products) {
      if (!p || !id(p.id) || !text(p.productCode,40) || !/^[A-Z0-9_-]+$/.test(p.productCode) || !text(p.name,100) || !text(p.unit,10) || !integer(p.reorderPoint,0) || !integer(p.version,1) || !date(p.createdAt) || !date(p.updatedAt) || p.updatedAt < p.createdAt || !(p.deletedAt === null || date(p.deletedAt)) || (p.deletedAt !== null && p.deletedAt < p.createdAt) || ids.has(p.id) || codes.has(p.productCode)) bad();
      ids.add(p.id);
      codes.add(p.productCode);
      const stock = stockMap.get(p.id);
      if (!stock) bad();
      // 単項目の形式だけでなく、商品と在庫の業務上の関係も確認します。
      if (stock.updatedAt < p.createdAt) bad();
      if (p.deletedAt !== null && (stock.quantity !== 0 || p.deletedAt > p.updatedAt)) bad();
      // DBモデルと画面モデルを分離。削除済みも検証し、一覧からだけ除外します。
      if (p.deletedAt === null) result.push({ id:p.id, code:p.productCode, name:p.name, unit:p.unit, point:p.reorderPoint, stock:stock.quantity, version:p.version });
    }
    if (ids.size !== stockMap.size) bad();
    HistoryValidation.validate(products,stocks,movements,cancellations);
    return result;
  }
  async function readProducts({ includeHistory = false } = {}) {
    const db = await open();
    const snapshot = await new Promise((resolve, reject) => {
      try {
        // 4ストアを同じreadonlyトランザクションで読み、整合した組を取得します。
        const tx = db.transaction(['products','stocks','movements','cancellations'], 'readonly');
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        const movements = tx.objectStore('movements').getAll();
        const cancellations = tx.objectStore('cancellations').getAll();
        tx.oncomplete = () => resolve({ products:products.result, stocks:stocks.result, movements:movements.result, cancellations:cancellations.result });
        tx.onabort = () => reject(failure('商品データの読み込みに失敗しました。再試行してください。'));
        tx.onerror = () => {}; // abortで日本語エラーに変換します。
      } catch { reject(failure('商品データを読み込めません。接続を確認して再試行してください。')); }
    });
    const products = validateSnapshot(snapshot.products, snapshot.stocks, snapshot.movements, snapshot.cancellations);
    return includeHistory ? {products, movements:snapshot.movements, cancellations:snapshot.cancellations} : products;
  }
  async function registerProduct(input, { mode } = {}) {
    // 画面のチェックを迂回して呼ばれても、デモ・不正入力は保存しません。
    if (mode !== 'normal') throw failure('通常モードでのみ商品を登録できます。', 'MODE');
    const { value, errors } = validateProductInput(input);
    if (Object.keys(errors).length) throw failure(Object.values(errors)[0], 'INPUT');
    const current = generation;
    const db = await open();
    if (current !== generation) throw failure('接続が変更されました。一覧を再読み込みしてください。');
    let product;
    try {
      const now = new Date().toISOString();
      product = { id:crypto.randomUUID(), productCode:value.code, name:value.name, unit:value.unit,
        reorderPoint:value.point, createdAt:now, updatedAt:now, deletedAt:null, version:1 };
    } catch { throw failure('商品IDを作成できません。安全な接続とブラウザ設定を確認してください。'); }
    const stock = { productId:product.id, quantity:0, updatedAt:product.createdAt, version:1 };
    validateSnapshot([product], [stock]);
    return new Promise((resolve, reject) => {
      let tx;
      let reason = null;
      try {
        // 読み取り検証と2件の追加を同じトランザクション内で行います。
        tx = db.transaction(['products','stocks','movements','cancellations'], 'readwrite');
        tx.oncomplete = () => { publishChange(); resolve(product); };
        tx.onabort = () => reject(reason || (tx.error?.name === 'ConstraintError'
          ? failure('商品コードなどが重複しています。削除済みの商品コードも再利用できません。', 'DUPLICATE')
          : failure('商品の保存に失敗しました。商品と初期在庫は登録されていません。')));
        tx.onerror = () => {}; // エラーを握りつぶさず、abort時に通知します。
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        const movements = tx.objectStore('movements').getAll();
        const cancellations = tx.objectStore('cancellations').getAll();
        cancellations.onsuccess = () => {
          try {
            validateSnapshot(products.result, stocks.result, movements.result, cancellations.result);
            tx.objectStore('products').add(product);
            tx.objectStore('stocks').add(stock);
          } catch (error) {
            reason = error.name === 'InventoryError' ? error : failure('商品の保存処理中にエラーが発生しました。商品と初期在庫は登録されていません。');
            tx.abort();
          }
        };
      } catch {
        reason = failure('商品の保存を開始できません。接続を確認して再試行してください。');
        if (tx) { try { tx.abort(); } catch { reject(reason); } }
        else reject(reason);
      }
    });
  }
  async function updateProduct(productId, expectedVersion, input, { mode } = {}) {
    if (mode !== 'normal') throw failure('通常モードでのみ商品を編集できます。', 'MODE');
    const { value, errors } = validateProductInput(input);
    if (Object.keys(errors).length) throw failure(Object.values(errors)[0], 'INPUT');
    if (!id(productId) || !integer(expectedVersion,1)) throw failure('商品IDまたは更新番号が不正です。画面を開き直してください。', 'INPUT');
    const current = generation;
    const db = await open();
    if (current !== generation) throw failure('接続が変更されました。一覧を再読み込みしてください。');
    return new Promise((resolve,reject) => {
      let tx, reason = null, updated;
      try {
        tx = db.transaction(['products','stocks','movements','cancellations'],'readwrite');
        tx.oncomplete = () => { publishChange(); resolve(updated); };
        tx.onabort = () => reject(reason || failure('商品の編集を保存できませんでした。入力を保持しています。'));
        tx.onerror = () => {};
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        const movements = tx.objectStore('movements').getAll();
        const cancellations = tx.objectStore('cancellations').getAll();
        cancellations.onsuccess = () => {
          try {
            validateSnapshot(products.result,stocks.result,movements.result,cancellations.result);
            const latest = products.result.find(p => p.id === productId);
            if (!latest || latest.deletedAt !== null) throw failure('対象商品が存在しないか削除済みです。一覧を再確認してください。', 'NOT_FOUND');
            if (latest.productCode !== value.code) throw failure('商品コードは変更できません。元の商品コードを確認してください。', 'INPUT');
            if (latest.unit !== value.unit && HistoryValidation.hasMovements(movements.result,productId)) throw failure('入出庫履歴がある商品の単位は変更できません。', 'INPUT');
            if (latest.version !== expectedVersion) throw failure('別のタブで商品が更新されています。入力を控え、一覧から最新情報を開き直して再確認してください。', 'CONFLICT');
            if (!Number.isSafeInteger(latest.version + 1)) throw failure('更新番号の上限に達しています。', 'INPUT');
            // 時計が過去に戻った場合でも既存の日時整合性を壊しません。
            const updatedAt = new Date(Math.max(Date.now(),Date.parse(latest.updatedAt)+1)).toISOString();
            updated = {...latest,name:value.name,unit:value.unit,reorderPoint:value.point,updatedAt,version:latest.version+1};
            validateSnapshot(products.result.map(p=>p.id===productId?updated:p),stocks.result,movements.result,cancellations.result);
            tx.objectStore('products').put(updated);
          } catch(error) {
            reason = error.name === 'InventoryError' ? error : failure('商品の編集処理に失敗しました。入力は保持しています。');
            tx.abort();
          }
        };
      } catch {
        reason = failure('商品の編集を開始できません。接続を確認してください。');
        if(tx) {try{tx.abort()}catch{reject(reason)}}else reject(reason);
      }
    });
  }
  // 在庫の読み取り・計算・更新と履歴追加を同じ取引にまとめます。
  async function postMovement(input, { mode } = {}) {
    if (mode !== 'normal') throw failure('通常モードでのみ入出庫を保存できます。', 'MODE');
    const {value,errors} = validateMovementInput(input);
    if (Object.keys(errors).length) throw failure(Object.values(errors)[0], 'INPUT');
    if (!id(input.operationId) || !id(input.productId) || !integer(input.expectedProductVersion,1) || !['IN','OUT'].includes(input.type) || input.occurredAt !== undefined) throw failure('操作ID・商品・種別が不正です。日時は自動記録します。', 'INPUT');
    const current = generation;
    const db = await open();
    if (current !== generation) throw failure('接続が変更されました。一覧を再取得してください。');
    return new Promise((resolve,reject)=>{
      let tx, reason=null, result;
      try {
        tx=db.transaction(['products','stocks','movements','cancellations'],'readwrite');
        tx.oncomplete=()=>{ if (!result.replayed) publishChange(); resolve(result); };
        tx.onabort=()=>reject(reason || failure('入出庫の保存に失敗しました。在庫・履歴は変更していません。'));
        tx.onerror=()=>{};
        const ps=tx.objectStore('products').getAll(), ss=tx.objectStore('stocks').getAll(), ms=tx.objectStore('movements').getAll(), cs=tx.objectStore('cancellations').getAll();
        // リクエストは投入順に完了。最後の読み取り後も同じtx内で書き込みます。
        cs.onsuccess=()=>{
          try {
            validateSnapshot(ps.result,ss.result,ms.result,cs.result);
            const previous=ms.result.find(m=>m.id===input.operationId);
            // 成功後の再送は、商品versionが変わっていても再更新しません。
            if (previous) {
              if (previous.productId!==input.productId || previous.type!==input.type || previous.quantity!==value.quantity || previous.note!==value.note) throw failure('同じ操作IDを異なる内容に使うことはできません。', 'DUPLICATE');
              result={movement:previous,replayed:true};return;
            }
            const p=ps.result.find(p=>p.id===input.productId), stock=ss.result.find(s=>s.productId===input.productId);
            if (!p || p.deletedAt!==null) throw failure('商品が存在しないか削除済みのため操作できません。', 'NOT_FOUND');
            if (p.version!==input.expectedProductVersion) throw failure('商品情報が変更されています。入力を控え、最新の商品を開き直して再確認してください。', 'CONFLICT');
            const after=stock.quantity+(input.type==='IN'?value.quantity:-value.quantity);
            if (after<0) throw failure('在庫が不足しているため出庫できません。', 'INPUT');
            if (!integer(after,0) || !Number.isSafeInteger(stock.version+1)) throw failure('在庫数または在庫versionの安全な整数上限を超えます。', 'INPUT');
            const time=new Date(Math.max(Date.now(),Date.parse(stock.updatedAt),Date.parse(p.createdAt))).toISOString();
            const movement={id:input.operationId,productId:p.id,type:input.type,quantity:value.quantity,stockBefore:stock.quantity,stockAfter:after,stockVersionBefore:stock.version,stockVersionAfter:stock.version+1,productCodeSnapshot:p.productCode,productNameSnapshot:p.name,unitSnapshot:p.unit,occurredAt:time,note:value.note,actorId:null};
            const nextStock={...stock,quantity:after,version:stock.version+1,updatedAt:time};
            validateSnapshot(ps.result,ss.result.map(s=>s.productId===p.id?nextStock:s),[...ms.result,movement],cs.result);
            tx.objectStore('stocks').put(nextStock);
            tx.objectStore('movements').add(movement);
            result={movement,replayed:false};
          } catch(error) {
            reason=error.name==='InventoryError'?error:failure('入出庫処理に失敗しました。在庫・履歴は変更していません。');
            tx.abort();
          }
        };
      } catch {
        reason=failure('入出庫の保存を開始できません。接続を確認してください。');
        if(tx){try{tx.abort()}catch{reject(reason)}}else reject(reason);
      }
    });
  }
  // 元取引は保持し、在庫更新と取消レコード追加だけを一括確定します。
  async function cancelMovement(input, { mode } = {}) {
    if (mode !== 'normal') throw failure('通常モードでのみ取消を保存できます。', 'MODE');
    const {value,errors} = validateCancellationInput(input);
    if (Object.keys(errors).length) throw failure(errors.reason, 'INPUT');
    if (!id(input.operationId) || !id(input.movementId) || input.quantity !== undefined || input.cancelledAt !== undefined) throw failure('取消操作ID・元取引が不正です。数量・日時は指定できません。', 'INPUT');
    const current = generation, db = await open();
    if (current !== generation) throw failure('接続が変更されました。一覧を再取得してください。');
    return new Promise((resolve,reject)=>{
      let tx, reason=null, result;
      try {
        tx=db.transaction(['products','stocks','movements','cancellations'],'readwrite');
        tx.oncomplete=()=>{if(!result.replayed)publishChange();resolve(result)};
        tx.onabort=()=>reject(reason||failure('取消の保存に失敗しました。在庫・履歴は変更していません。'));
        tx.onerror=()=>{};
        const ps=tx.objectStore('products').getAll(),ss=tx.objectStore('stocks').getAll(),ms=tx.objectStore('movements').getAll(),cs=tx.objectStore('cancellations').getAll();
        cs.onsuccess=()=>{
          try {
            validateSnapshot(ps.result,ss.result,ms.result,cs.result);
            const previous=cs.result.find(c=>c.id===input.operationId);
            if(previous){
              if(previous.movementId!==input.movementId||previous.reason!==value.reason)throw failure('同じ操作IDを異なる取消内容に使うことはできません。','DUPLICATE');
              result={cancellation:previous,replayed:true};return;
            }
            const movement=ms.result.find(m=>m.id===input.movementId);
            const product=ps.result.find(p=>p.id===movement?.productId);
            if(!movement||!product||product.deletedAt!==null)throw failure('元取引または商品が存在しないか、商品が削除済みです。','NOT_FOUND');
            if(cs.result.some(c=>c.movementId===movement.id))throw failure('この取引は既に取消済みです。二重取消はできません。','DUPLICATE');
            const stock=ss.result.find(s=>s.productId===product.id);
            const after=stock.quantity+(movement.type==='IN'?-movement.quantity:movement.quantity);
            if(after<0)throw failure('在庫が不足するため入庫を取り消せません。','INPUT');
            if(!integer(after,0)||!Number.isSafeInteger(stock.version+1))throw failure('取消後の在庫数またはversionが安全な整数上限を超えます。','INPUT');
            const time=new Date(Math.max(Date.now(),Date.parse(stock.updatedAt),Date.parse(movement.occurredAt))).toISOString();
            const cancellation={id:input.operationId,movementId:movement.id,productId:product.id,stockBefore:stock.quantity,stockAfter:after,stockVersionBefore:stock.version,stockVersionAfter:stock.version+1,reason:value.reason,cancelledAt:time,actorId:null};
            const nextStock={...stock,quantity:after,version:stock.version+1,updatedAt:time};
            validateSnapshot(ps.result,ss.result.map(s=>s.productId===product.id?nextStock:s),ms.result,[...cs.result,cancellation]);
            tx.objectStore('stocks').put(nextStock);
            tx.objectStore('cancellations').add(cancellation);
            result={cancellation,replayed:false};
          }catch(error){reason=error.name==='InventoryError'?error:failure('取消処理に失敗しました。在庫・履歴は変更していません。');tx.abort()}
        };
      }catch{reason=failure('取消の保存を開始できません。接続を確認してください。');if(tx){try{tx.abort()}catch{reject(reason)}}else reject(reason)}
    });
  }
  // 通知は再取得のきっかけだけ。正しさは保存トランザクションのversion照合で保証。
  const changeListeners = new Set();
  let channel;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('stock-note-products');
      channel.onmessage = event => {
        if (event.data?.type === 'products-changed') changeListeners.forEach(listener=>listener());
      };
    }
  } catch { /* 通知が使えなくても保存時のversion照合は有効です。 */ }
  function publishChange() { try { channel?.postMessage({type:'products-changed'}); } catch {} }
  return { NAME, VERSION, isReliabilityError, open, close, hasMovements:HistoryValidation.hasMovements, readProducts, validateSnapshot, registerProduct, updateProduct, postMovement, cancelMovement,
    subscribeChanges(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
})();
