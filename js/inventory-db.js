'use strict';

// DBの接続・読み取り・商品登録／編集を担当します。入出庫の書き込みは未実装です。
const InventoryDB = (() => {
  const NAME = 'stock-note';
  const VERSION = 1;
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
        // バージョンごとの変更を追加します。既存ストアを削除・再作成しません。
        if (event.oldVersion < 1) {
          const products = request.result.createObjectStore('products', { keyPath:'id' });
          products.createIndex('productCode', 'productCode', { unique:true });
          request.result.createObjectStore('stocks', { keyPath:'productId' });
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
          const tx = db.transaction(['products', 'stocks'], 'readonly');
          const p = tx.objectStore('products');
          const index = p.index('productCode');
          if (p.keyPath !== 'id' || p.autoIncrement || index.keyPath !== 'productCode' || !index.unique || index.multiEntry || tx.objectStore('stocks').keyPath !== 'productId' || tx.objectStore('stocks').autoIncrement) throw failure('schema');
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
  function validateSnapshot(products, stocks) {
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
    return result;
  }
  async function readProducts() {
    const db = await open();
    const snapshot = await new Promise((resolve, reject) => {
      try {
        // 2ストアを同じreadonlyトランザクションで読むと、整合した組を取得できます。
        const tx = db.transaction(['products','stocks'], 'readonly');
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        tx.oncomplete = () => resolve({ products:products.result, stocks:stocks.result });
        tx.onabort = () => reject(failure('商品データの読み込みに失敗しました。再試行してください。'));
        tx.onerror = () => {}; // abortで日本語エラーに変換します。
      } catch { reject(failure('商品データを読み込めません。接続を確認して再試行してください。')); }
    });
    return validateSnapshot(snapshot.products, snapshot.stocks);
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
        tx = db.transaction(['products','stocks'], 'readwrite');
        tx.oncomplete = () => { publishChange(); resolve(product); };
        tx.onabort = () => reject(reason || (tx.error?.name === 'ConstraintError'
          ? failure('商品コードなどが重複しています。削除済みの商品コードも再利用できません。', 'DUPLICATE')
          : failure('商品の保存に失敗しました。商品と初期在庫は登録されていません。')));
        tx.onerror = () => {}; // エラーを握りつぶさず、abort時に通知します。
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        stocks.onsuccess = () => {
          try {
            validateSnapshot(products.result, stocks.result);
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
        tx = db.transaction(['products','stocks'],'readwrite');
        tx.oncomplete = () => { publishChange(); resolve(updated); };
        tx.onabort = () => reject(reason || failure('商品の編集を保存できませんでした。入力を保持しています。'));
        tx.onerror = () => {};
        const products = tx.objectStore('products').getAll();
        const stocks = tx.objectStore('stocks').getAll();
        stocks.onsuccess = () => {
          try {
            validateSnapshot(products.result,stocks.result);
            const latest = products.result.find(p => p.id === productId);
            if (!latest || latest.deletedAt !== null) throw failure('対象商品が存在しないか削除済みです。一覧を再確認してください。', 'NOT_FOUND');
            if (latest.productCode !== value.code) throw failure('商品コードは変更できません。元の商品コードを確認してください。', 'INPUT');
            if (latest.version !== expectedVersion) throw failure('別のタブで商品が更新されています。入力を控え、一覧から最新情報を開き直して再確認してください。', 'CONFLICT');
            if (!Number.isSafeInteger(latest.version + 1)) throw failure('更新番号の上限に達しています。', 'INPUT');
            // 時計が過去に戻った場合でも既存の日時整合性を壊しません。
            const updatedAt = new Date(Math.max(Date.now(),Date.parse(latest.updatedAt)+1)).toISOString();
            updated = {...latest,name:value.name,unit:value.unit,reorderPoint:value.point,updatedAt,version:latest.version+1};
            validateSnapshot(products.result.map(p=>p.id===productId?updated:p),stocks.result);
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
  return { NAME, VERSION, isReliabilityError, open, close, readProducts, validateSnapshot, registerProduct, updateProduct,
    subscribeChanges(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
})();
