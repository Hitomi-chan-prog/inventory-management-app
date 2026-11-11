const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

test('IndexedDB保存基盤', async t => {
  const root = path.resolve(__dirname, '..');
  const allowed = ['index.html','app.js','styles.css','js/inventory-db.js','js/history-validation.js','js/history-query.js','js/product-validation.js','js/movement-validation.js'];
  const server = http.createServer((req,res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!allowed.includes(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(path.join(root,file)));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser = await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true});
    const base = `http://127.0.0.1:${server.address().port}`;
    const fixture = async (run, init) => {
      const context = await browser.newContext();
      try {
        if (init) await context.addInitScript(init);
        const page = await context.newPage();
        await page.goto(base);
        await run(page,context);
      } finally { await context.close(); }
    };
    const ready = page=>page.waitForFunction(()=>dbState==='ready');
    // clickの完了とhashchange後の描画完了は別。期待する表示・データを待ちます。
    const waitMode = (page, mode, count) => page.waitForFunction(({mode,count}) =>
      document.querySelector('#mode-label')?.textContent === mode &&
      (mode === 'デモモード' || dbState === 'ready') &&
      document.querySelector('tbody') && document.querySelectorAll('tbody tr').length === count,
      {mode,count});
    // 保存APIをアプリへ追加せず、テストだけで検証用レコードを投入します。
    const seed = page=>page.evaluate(async()=>{
      const db=await InventoryDB.open();
      const id='00000000-0000-4000-8000-000000000001';
      const now='2026-11-10T00:00:00.000Z';
      const p={id,productCode:'A-1',name:'商品<&',unit:'個',reorderPoint:0,createdAt:now,updatedAt:now,deletedAt:null,version:1};
      const s={productId:id,quantity:0,updatedAt:now,version:1};
      await new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks'],'readwrite');tx.objectStore('products').add(p);tx.objectStore('stocks').add(s);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
      return {p,s};
    });
    await t.test('初期作成・スキーマ・0件・切断後の再接続',()=>fixture(async page=>{
      await ready(page);
      assert.deepEqual(await page.evaluate(()=>InventoryDB.readProducts()),[]);
      assert.deepEqual(await page.evaluate(async()=>{const db=await InventoryDB.open();const tx=db.transaction(['products','stocks']);const p=tx.objectStore('products');return {version:db.version,key:p.keyPath,stockKey:tx.objectStore('stocks').keyPath,index:p.index('productCode').keyPath,unique:p.index('productCode').unique};}),{version:2,key:'id',stockKey:'productId',index:'productCode',unique:true});
      await page.evaluate(()=>InventoryDB.close());
      assert.deepEqual(await page.evaluate(()=>InventoryDB.readProducts()),[]);
    }));
    await t.test('実DBから読み込み・一覧・安全表示・操作無効・再読み込み',()=>fixture(async page=>{
      await ready(page);await seed(page);await page.reload();await ready(page);
      assert.equal(await page.locator('tbody tr').count(),1);
      assert.equal(await page.locator('tbody strong').textContent(),'商品<&');
      assert.equal(await page.locator('img').count(),0);
      assert.equal(await page.locator('[data-operation=IN]').isDisabled(),false);
      assert.equal(await page.locator('[data-operation=OUT]').isDisabled(),false);
      await page.locator('#search').fill('商品');
      assert.equal(await page.locator('[data-operation=IN]').isDisabled(),false);
      await page.locator('#alert-only').check();
      assert.equal(await page.locator('[data-operation=OUT]').isDisabled(),false);
      await page.locator('#mode-toggle').click();await waitMode(page,'デモモード',5);assert.equal(await page.locator('tbody tr').count(),5);
      await page.locator('#mode-toggle').click();await waitMode(page,'通常モード',1);assert.equal(await page.locator('tbody tr').count(),1);
    }));
    await t.test('productCode一意制約・主キー重複拒否',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);
      const result=await page.evaluate(async({p,s})=>{
        const db=await InventoryDB.open();const results=[];
        for(const [store,row] of [['products',p],['products',{...p,id:'00000000-0000-4000-8000-000000000002'}],['stocks',s]]) {
          results.push(await new Promise(resolve=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).add(row);tx.oncomplete=()=>resolve('unexpected');tx.onabort=()=>resolve(tx.error.name)}));
        }return results;
      },{p,s});
      assert.deepEqual(result,['ConstraintError','ConstraintError','ConstraintError']);
    }));
    await t.test('不正な型・範囲・関連を拒否し削除済みは除外',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);
      const results=await page.evaluate(({p,s})=>{
        const cases=[[[{...p,reorderPoint:'0'}],[s]],[[{...p,reorderPoint:-1}],[s]],[[{...p,version:0}],[s]],[[{...p,id:'bad'}],[s]],[[{...p,productCode:'abc'}],[s]],[[{...p,name:' '}],[s]],[[{...p,createdAt:'bad'}],[s]],[[p],[{...s,quantity:'0'}]],[[p],[{...s,quantity:-1}]],[[p],[{...s,quantity:1.5}]],[[p],[{...s,quantity:Number.MAX_SAFE_INTEGER+1}]],[[p],[]],[[],[s]]];
        return cases.map(([p,s])=>{try{InventoryDB.validateSnapshot(p,s);return false}catch{return true}});
      },{p,s});
      assert.ok(results.every(Boolean));
      assert.deepEqual(await page.evaluate(({p,s})=>InventoryDB.validateSnapshot([{...p,deletedAt:p.updatedAt}],[s]),{p,s}),[]);
    }));
    await t.test('実DBの不正データを0件に見せずエラー表示・再試行',()=>fixture(async page=>{
      await ready(page);await seed(page);
      await page.evaluate(async()=>{const db=await InventoryDB.open();await new Promise(r=>{const tx=db.transaction('stocks','readwrite');tx.objectStore('stocks').clear();tx.oncomplete=r})});
      await page.reload();await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/不正/);
      assert.equal(await page.locator('.stats').count(),0);
      await page.locator('#db-retry').click();await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/不正/);
    }));
    await t.test('接続失敗を日本語表示',()=>fixture(async page=>{
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/開けません/);
      assert.equal(await page.locator('tbody').count(),0);
    },()=>{IDBFactory.prototype.open=function(){throw new DOMException('denied','SecurityError')}}));
    await t.test('読み取りトランザクション失敗を0件と区別',()=>fixture(async page=>{
      await ready(page);
      await page.evaluate(()=>{InventoryDB.close();const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);queueMicrotask(()=>tx.abort());return tx};dbState='idle';renderRoute()});
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/読み込みに失敗/);
      assert.equal(await page.locator('.stats').count(),0);
    }));
    await t.test('不正スキーマを検出しデータを削除しない',()=>fixture(async page=>{
      await ready(page);
      await page.evaluate(async()=>{
        InventoryDB.close();
        await new Promise((resolve,reject)=>{const req=indexedDB.deleteDatabase(InventoryDB.NAME);req.onsuccess=resolve;req.onerror=()=>reject(req.error)});
        await new Promise((resolve,reject)=>{const req=indexedDB.open(InventoryDB.NAME,1);req.onupgradeneeded=()=>{const p=req.result.createObjectStore('products',{keyPath:'wrong'});p.createIndex('productCode','productCode',{unique:true});req.result.createObjectStore('stocks',{keyPath:'productId'})};req.onsuccess=()=>{req.result.close();resolve()};req.onerror=()=>reject(req.error)});
      });
      await page.reload();await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/構造が不正/);
      assert.equal(await page.evaluate(async()=> (await indexedDB.databases()).some(db=>db.name===InventoryDB.NAME)),true);
    }));
    await t.test('新しいDBバージョンを旧アプリが開くとエラー',()=>fixture(async page=>{
      await ready(page);await page.evaluate(async()=>{InventoryDB.close();await new Promise((resolve,reject)=>{const req=indexedDB.open(InventoryDB.NAME,3);req.onsuccess=()=>{req.result.close();resolve()};req.onerror=()=>reject(req.error)})});
      await page.reload();await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/バージョン/);
    }));
    await t.test('versionchangeで接続を閉じ他タブの更新を妨げない',()=>fixture(async(page,context)=>{
      await ready(page);const other=await context.newPage();await other.goto(base);await ready(other);
      await other.evaluate(async()=>{InventoryDB.close();await new Promise((resolve,reject)=>{const req=indexedDB.open(InventoryDB.NAME,3);req.onsuccess=()=>{req.result.close();resolve()};req.onerror=()=>reject(req.error)})});
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/別のタブ/);
    }));
    await t.test('実タブの更新待ちは旧接続を閉じると再開する',()=>fixture(async(page,context)=>{
      await ready(page);
      await page.evaluate(async()=>{
        InventoryDB.close();
        await new Promise((resolve,reject)=>{const req=indexedDB.open(InventoryDB.NAME,2);req.onsuccess=()=>{window.blocker=req.result;resolve()};req.onerror=()=>reject(req.error)});
      });
      const upgraded=await context.newPage();
      await upgraded.route('**/js/inventory-db.js',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'js/inventory-db.js'),'utf8').replace('const VERSION = 2;', 'const VERSION = 3;')}));
      await upgraded.goto(base);
      await upgraded.waitForFunction(()=>document.querySelector('#db-message')?.textContent.includes('更新待ち'));
      await page.evaluate(()=>window.blocker.close());
      await ready(upgraded);
      assert.equal(await upgraded.locator('tbody tr').count(),0);
    }));
    await t.test('更新待ちとタイムアウトを明示する',()=>fixture(async page=>{
      await page.waitForFunction(()=>document.querySelector('#db-message')?.textContent.includes('更新待ち'));
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-message').textContent(),/タイムアウト/);
    },()=>{
      const set=window.setTimeout.bind(window);
      window.setTimeout=(fn,ms,...args)=>set(fn,ms===8000?300:ms,...args);
      IDBFactory.prototype.open=function(){const req={};set(()=>req.onblocked?.(),20);return req};
    }));
    await t.test('モード切替後の遅い成功・失敗を破棄',()=>fixture(async page=>{
      await ready(page);
      for(const fails of [false,true]) {
        await page.evaluate(fails=>{InventoryDB.readProducts=()=>new Promise((resolve,reject)=>{window.finishRead=()=>fails?reject(new Error('古いエラー')):resolve([])});dbState='idle';renderRoute()},fails);
        await page.locator('#mode-toggle').click();
        await page.evaluate(()=>window.finishRead());
        await waitMode(page,'デモモード',5);
        assert.equal(await page.locator('#mode-label').textContent(),'デモモード');
        assert.equal(await page.locator('tbody tr').count(),5);
        assert.equal(await page.locator('#db-message').count(),0);
        await page.reload();await ready(page);
      }
    }));
    await t.test('読み込み中の画面遷移で登録入力を破棄しない',()=>fixture(async page=>{
      await ready(page);
      await page.evaluate(()=>{InventoryDB.readProducts=()=>new Promise(resolve=>window.finishRead=()=>resolve([]));dbState='idle';renderRoute()});
      await page.locator('[data-nav=product]').click();await page.locator('[name=name]').fill('保持する入力');
      await page.evaluate(()=>window.finishRead());
      assert.equal(await page.locator('[name=name]').inputValue(),'保持する入力');
    }));
    await t.test('登録フォーム入力中の読み込み失敗を独立通知し全入力を保持',()=>fixture(async page=>{
      await ready(page);
      await page.evaluate(()=>{InventoryDB.readProducts=()=>new Promise((_,reject)=>window.failRead=()=>reject(new Error('読み込み失敗の確認')));dbState='idle';renderRoute()});
      await page.locator('[data-nav=product]').click();
      const values={code:' KEEP-1 ',name:'保持する商品',unit:'箱',point:'12'};
      for(const [name,value] of Object.entries(values)) await page.locator(`[name=${name}]`).fill(value);
      await page.evaluate(()=>{window.originalForm=document.querySelector('#product-form');window.failRead()});
      await page.waitForFunction(()=>dbState==='error');
      assert.equal(await page.locator('#db-notice').isVisible(),true);
      assert.match(await page.locator('#db-notice').textContent(),/読み込み失敗/);
      assert.equal(await page.evaluate(()=>window.originalForm===document.querySelector('#product-form')),true);
      for(const [name,value] of Object.entries(values)) assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
      await page.locator('[name=name]').fill('追加入力');
      assert.equal(await page.locator('#db-notice').isVisible(),true);
      page.once('dialog',d=>d.accept());await page.locator('#mode-toggle').click();
      assert.equal(await page.locator('#db-notice').isVisible(),false);
    }));
    for(const scenario of ['削除済み商品に在庫5','在庫更新日時が作成前','削除日時が最終更新後']) {
      await t.test(scenario+'は不整合で一覧表示せずDBも変更しない',()=>fixture(async page=>{
        await ready(page);const {p,s}=await seed(page);
        if(scenario==='削除済み商品に在庫5'){p.deletedAt=p.updatedAt;s.quantity=5}
        if(scenario==='在庫更新日時が作成前')s.updatedAt='2020-01-01T00:00:00.000Z';
        if(scenario==='削除日時が最終更新後')p.deletedAt='2027-01-01T00:00:00.000Z';
        await page.evaluate(async({p,s})=>{const db=await InventoryDB.open();await new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks'],'readwrite');tx.objectStore('products').put(p);tx.objectStore('stocks').put(s);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)})},{p,s});
        await page.reload();await page.waitForFunction(()=>dbState==='error');
        assert.match(await page.locator('#db-notice').textContent(),/不正/);
        assert.equal(await page.locator('.stats').count(),0);
        assert.equal(await page.locator('tbody').count(),0);
        const stored=await page.evaluate(async id=>{const db=await InventoryDB.open();return new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks']);const p=tx.objectStore('products').get(id),s=tx.objectStore('stocks').get(id);tx.oncomplete=()=>resolve({p:p.result,s:s.result});tx.onabort=()=>reject(tx.error)})},p.id);
        assert.deepEqual(stored,{p,s});
      }));
    }
    await t.test('正常な日時境界と商品・在庫の異なる更新日時を許可',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);
      const result=await page.evaluate(({p,s})=>{
        const later='2026-11-11T00:00:00.000Z';
        return [InventoryDB.validateSnapshot([p],[s]).length,InventoryDB.validateSnapshot([{...p,updatedAt:later}],[s]).length,InventoryDB.validateSnapshot([p],[{...s,updatedAt:later}]).length,InventoryDB.validateSnapshot([{...p,deletedAt:later,updatedAt:later}],[s]).length];
      },{p,s});
      assert.deepEqual(result,[1,1,1,0]);
    }));
    await t.test('接続タイムアウト後の遅い成功は接続を閉じ成功表示しない',()=>fixture(async page=>{
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-notice').textContent(),/タイムアウト/);
      await page.waitForFunction(()=>window.lateConnectionClosed===true);
      assert.equal(await page.locator('.stats').count(),0);
      assert.equal(await page.evaluate(()=>dbState),'error');
    },()=>{
      const original=IDBFactory.prototype.open;
      const set=window.setTimeout.bind(window);
      // 実DBの準備完了後にタイムアウトを先に発火し、CPU負荷に依存させません。
      window.setTimeout=(fn,ms,...args)=>{if(ms===8000){window.triggerDbTimeout=fn;return set(fn,10000,...args)}return set(fn,ms,...args)};
      IDBFactory.prototype.open=function(...args){
        const req=original.apply(this,args);
        return new Proxy(req,{
          get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value},
          set(target,key,value){
            if(key==='onsuccess')target.onsuccess=event=>{
              const db=target.result;
              const close=db.close.bind(db);
              db.close=()=>{window.lateConnectionClosed=true;close()};
              window.triggerDbTimeout();
              set(()=>value(event),0);
            };
            else Reflect.set(target,key,value,target);
            return true;
          }
        });
      };
    }));
    await t.test('通常→デモ→通常で古い成功・失敗が新しい読み込み結果を上書きしない',()=>fixture(async page=>{
      await ready(page);
      for(const rejectOld of [false,true]) {
        await page.evaluate(rejectOld=>{
          window.pendingReads=[];
          InventoryDB.readProducts=()=>new Promise((resolve,reject)=>window.pendingReads.push({resolve,reject}));
          dbState='idle';renderRoute();
        },rejectOld);
        await page.locator('#mode-toggle').click();await page.locator('#mode-toggle').click();
        await page.waitForFunction(()=>window.pendingReads.length===2);
        await page.evaluate(()=>window.pendingReads[1].resolve([{id:'new',code:'NEW',name:'最新結果',unit:'個',point:0,stock:0}]));
        await ready(page);
        await page.evaluate(rejectOld=>rejectOld?window.pendingReads[0].reject(new Error('古い失敗')):window.pendingReads[0].resolve([]),rejectOld);
        assert.equal(await page.locator('tbody tr').count(),1);
        assert.equal(await page.locator('tbody strong').textContent(),'最新結果');
        assert.equal(await page.locator('#db-notice').isVisible(),false);
        await page.reload();await ready(page);
      }
    }));
    await t.test('予期しない接続終了を通知し通常一覧を成功表示しない',()=>fixture(async page=>{
      await ready(page);
      // 強制終了はブラウザAPIで直接発生させられないため、closeイベントを注入します。
      await page.evaluate(async()=>{const db=await InventoryDB.open();db.dispatchEvent(new Event('close'))});
      await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-notice').textContent(),/切断/);
      assert.equal(await page.locator('.stats').count(),0);
      await page.locator('#db-retry').click();await ready(page);
      assert.equal(await page.locator('#db-notice').isVisible(),false);
      assert.equal(await page.locator('tbody tr').count(),0);
    }));
    const input = {code:' new-1 ',name:' 新商品<& ',unit:'個',point:'0'};
    const rawCounts = page=>page.evaluate(async()=>{const db=await InventoryDB.open();return new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks']);const p=tx.objectStore('products').getAll(),s=tx.objectStore('stocks').getAll();tx.oncomplete=()=>resolve({products:p.result,stocks:s.result});tx.onabort=()=>reject(tx.error)})});
    const fillRegistration = async page=>{
      await page.goto(base+'/#product/new');
      for(const [name,value] of Object.entries(input))await page.locator(`[name=${name}]`).fill(value);
    };
    await t.test('商品登録・初期在庫0・UUID・日時・件数・アラート・再読み込み',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();
      await page.waitForFunction(()=>location.hash==='#inventory' && document.querySelector('tbody tr'));
      assert.match(await page.locator('#status').textContent(),/商品を登録しました/);
      assert.equal(await page.locator('tbody strong').textContent(),'新商品<&');
      assert.equal(await page.locator('tbody .badge').textContent(),'要発注');
      assert.deepEqual(await page.locator('.stat-value').allTextContents(),['1件','1件','1件']);
      const rows=await rawCounts(page);assert.equal(rows.products.length,1);assert.equal(rows.stocks.length,1);
      const p=rows.products[0],s=rows.stocks[0];assert.match(p.id,/^[0-9a-f-]{36}$/);assert.equal(p.productCode,'NEW-1');assert.equal(p.version,1);assert.equal(p.createdAt,p.updatedAt);assert.equal(p.deletedAt,null);assert.equal(s.productId,p.id);assert.equal(s.quantity,0);assert.equal(s.version,1);assert.equal(s.updatedAt,p.createdAt);
      await page.reload();await ready(page);assert.equal(await page.locator('tbody tr').count(),1);
    }));
    await t.test('保存入口で入力を再検証しデモからの保存を拒否',()=>fixture(async page=>{
      await ready(page);
      const result=await page.evaluate(async input=>{
        const outcomes=[];
        for(const [data,options] of [[{...input,code:'ß'},{mode:'normal'}],[{...input,point:'1e3'},{mode:'normal'}],[input,{mode:'demo'}],[input,undefined]]) {
          try{await InventoryDB.registerProduct(data,options);outcomes.push(false)}catch{outcomes.push(true)}
        }return outcomes;
      },input);
      assert.deepEqual(result,[true,true,true,true]);assert.deepEqual(await rawCounts(page),{products:[],stocks:[]});
    }));
    for(const deleted of [false,true])await t.test(deleted?'論理削除後のコード再利用を拒否':'正規化後の重複コードを拒否し入力保持',()=>fixture(async page=>{
      await ready(page);await page.evaluate(input=>InventoryDB.registerProduct(input,{mode:'normal'}),input);
      if(deleted)await page.evaluate(async()=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('products','readwrite');const req=tx.objectStore('products').getAll();req.onsuccess=()=>{const p=req.result[0];p.deletedAt=new Date().toISOString();p.updatedAt=p.deletedAt;tx.objectStore('products').put(p)};tx.oncomplete=resolve})});
      await fillRegistration(page);await page.getByRole('button',{name:'商品を登録',exact:true}).click();
      await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/重複/);assert.doesNotMatch(await page.locator('#status').textContent(),/登録しました/);
      for(const [name,value]of Object.entries(input))assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
      assert.equal((await rawCounts(page)).products.length,1);assert.equal((await rawCounts(page)).stocks.length,1);
    }));
    for(const cause of ['exception','abort'])await t.test('初期在庫保存の'+cause+'で商品もロールバック',()=>fixture(async page=>{
      await ready(page);
      await page.evaluate(cause=>{
        const add=IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add=function(...args){
          if(this.name==='stocks'){
            if(cause==='exception')throw new DOMException('test failure','DataError');
            const request=add.apply(this,args);request.addEventListener('success',()=>this.transaction.abort());return request;
          }return add.apply(this,args);
        };
      },cause);
      await fillRegistration(page);await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/保存/);assert.doesNotMatch(await page.locator('#status').textContent(),/登録しました/);
      assert.deepEqual(await rawCounts(page),{products:[],stocks:[]});assert.equal(await page.locator('[name=code]').inputValue(),input.code);
    }));
    await t.test('保存中の二重送信防止とcomplete後だけ成功',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);
      await page.evaluate(()=>{
        window.saveCalls=0;const save=InventoryDB.registerProduct;
        InventoryDB.registerProduct=async(...args)=>{window.saveCalls++;await new Promise(resolve=>window.releaseSave=resolve);return save(...args)};
        window.completed=false;
        const transaction=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(args[1]==='readwrite')tx.addEventListener('complete',()=>window.completed=true);return tx};
        const form=document.querySelector('#product-form');form.requestSubmit();form.requestSubmit();
      });
      await page.waitForFunction(()=>savingProduct);
      assert.equal(await page.getByRole('button',{name:'保存中…'}).isDisabled(),true);
      assert.equal(await page.locator('#mode-toggle').isDisabled(),true);
      assert.equal(await page.evaluate(()=>window.saveCalls),1);
      assert.doesNotMatch(await page.locator('#status').textContent(),/登録しました/);
      await page.evaluate(()=>window.releaseSave());await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.evaluate(()=>window.completed),true);assert.match(await page.locator('#status').textContent(),/登録しました/);
      assert.equal((await rawCounts(page)).products.length,1);
    }));
    await t.test('デモ登録・編集の確認操作ではDBを書き換えない',()=>fixture(async page=>{
      await ready(page);await page.locator('#mode-toggle').click();await fillRegistration(page);
      await page.locator('#product-form button[type=submit]').click();assert.match(await page.locator('#status').textContent(),/保存していません/);
      await page.goto(base+'/#product/p1/edit');await page.locator('[name=name]').fill('編集デモ');await page.locator('#product-form button[type=submit]').click();
      assert.deepEqual(await rawCounts(page),{products:[],stocks:[]});
    }));
    await t.test('DB読み込み失敗時は登録を拒否',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);
      await page.evaluate(()=>{dbState='error';window.calls=0;InventoryDB.registerProduct=()=>{window.calls++;return Promise.resolve()}});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls),0);assert.match(await page.locator('#db-notice').textContent(),/読み込み/);
    }));
    await t.test('複数タブから同コードを同時登録して一方だけ成功',()=>fixture(async(page,context)=>{
      await ready(page);const other=await context.newPage();await other.goto(base);await ready(other);
      const attempt=page=>page.evaluate(async input=>{try{await InventoryDB.registerProduct(input,{mode:'normal'});return 'ok'}catch(error){return error.message}},input);
      const outcomes=await Promise.all([attempt(page),attempt(other)]);
      assert.equal(outcomes.filter(x=>x==='ok').length,1);assert.ok(outcomes.some(x=>x.includes('重複')));
      const rows=await rawCounts(page);assert.equal(rows.products.length,1);assert.equal(rows.stocks.length,1);
    }));
    await t.test('既存データ不整合なら登録せず元データ保持',()=>fixture(async page=>{
      await ready(page);await seed(page);await page.evaluate(async()=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('stocks','readwrite');tx.objectStore('stocks').clear();tx.oncomplete=resolve})});
      await assert.rejects(()=>page.evaluate(input=>InventoryDB.registerProduct(input,{mode:'normal'}),input),/不正/);
      const rows=await rawCounts(page);assert.equal(rows.products.length,1);assert.equal(rows.stocks.length,0);
    }));
    await t.test('登録後の一覧読込失敗は再登録不要と表示',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);await page.evaluate(()=>{InventoryDB.readProducts=()=>Promise.reject(new Error('test'))});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/登録は完了.*再登録せず/);
      assert.equal(await page.getByRole('button',{name:'登録済み（再登録不要）'}).isDisabled(),true);
      const rows=await rawCounts(page);
      assert.equal(rows.products.length,1);assert.equal(rows.stocks.length,1);
      for(const [name,value] of Object.entries(input))assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
      assert.equal(await page.locator('.stats').count(),0);
    }));
    await t.test('登録画面の直接URLからもDB読込後に登録できる',()=>fixture(async page=>{
      await ready(page);await page.goto(base+'/#product/new');await page.reload();await ready(page);
      for(const [name,value] of Object.entries(input))await page.locator(`[name=${name}]`).fill(value);
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct && location.hash==='#inventory');
      assert.equal((await rawCounts(page)).products.length,1);
    }));
    await t.test('保存トランザクション開始例外も日本語で通知し入力保持',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);
      await page.evaluate(()=>{const tx=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw new DOMException('test','InvalidStateError');return tx.apply(this,args)}});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/保存を開始できません/);
      assert.equal(await page.locator('[name=code]').inputValue(),input.code);
      assert.deepEqual(await rawCounts(page),{products:[],stocks:[]});
    }));
    await t.test('通常モードの商品編集を保存する',()=>fixture(async page=>{
      await ready(page);const product=await page.evaluate(input=>InventoryDB.registerProduct(input,{mode:'normal'}),input);
      await page.reload();await ready(page);await page.goto(base+'/#product/'+product.id+'/edit');
      await page.locator('[name=name]').fill('保存しない変更');await page.locator('#product-form button[type=submit]').click();
      await page.waitForFunction(()=>!savingProduct && location.hash==='#inventory');
      assert.match(await page.locator('#status').textContent(),/編集しました/);
      assert.equal((await rawCounts(page)).products[0].name,'保存しない変更');
    }));
    await t.test('保存中に戻る操作で一覧へ移動しても完了待ちが停止しない',()=>fixture(async page=>{
      await ready(page);await fillRegistration(page);
      await page.evaluate(()=>{const save=InventoryDB.registerProduct;InventoryDB.registerProduct=async(...args)=>{await new Promise(resolve=>window.releaseSave=resolve);return save(...args)}});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>savingProduct);
      await page.evaluate(()=>{location.hash='inventory'});await page.waitForFunction(()=>location.hash==='#inventory');
      await page.evaluate(()=>window.releaseSave());await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.locator('tbody tr').count(),1);assert.match(await page.locator('#status').textContent(),/登録しました/);
    }));
    for(const existing of [false,true]) await t.test('保存中に一覧移動し再取得失敗：古い'+(existing?'1件':'0件')+'表示を除去',()=>fixture(async page=>{
      await ready(page);
      if(existing){await seed(page);await page.reload();await ready(page)}
      await fillRegistration(page);
      await page.evaluate(()=>{const save=InventoryDB.registerProduct;InventoryDB.registerProduct=async(...args)=>{await new Promise(resolve=>window.releaseRegistration=resolve);return save(...args)}});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>savingProduct);
      await page.evaluate(()=>{location.hash='inventory'});
      await page.waitForFunction(()=>location.hash==='#inventory'&&document.querySelector('.stats'));
      assert.equal(await page.locator('tbody tr').count(),existing?1:0);
      await page.evaluate(()=>{InventoryDB.readProducts=()=>Promise.reject(new Error('再取得失敗'));window.releaseRegistration()});
      await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.evaluate(()=>dbState),'error');
      assert.equal(await page.locator('tbody').count(),0);
      assert.equal(await page.locator('.stats').count(),0);
      assert.equal(await page.locator('.stat-value').count(),0);
      assert.match(await page.locator('#db-message').textContent(),/登録は完了.*読み込みに失敗.*再登録せず/);
      assert.equal(await page.locator('#db-retry').isVisible(),true);
      const rows=await rawCounts(page);
      assert.equal(rows.products.length,existing?2:1);assert.equal(rows.stocks.length,existing?2:1);
      assert.equal(rows.products.filter(p=>p.productCode==='NEW-1').length,1);
      assert.ok(rows.stocks.every(s=>s.quantity===0));
    }));
    await t.test('モードを10往復して毎回描画完了とデータ分離を確認',()=>fixture(async page=>{
      await ready(page);await seed(page);await page.reload();await ready(page);
      for(let cycle=0;cycle<10;cycle++) {
        await page.locator('#mode-toggle').click();await waitMode(page,'デモモード',5);
        assert.deepEqual(await page.locator('tbody small').allTextContents(),['ST-001','ST-002','ST-003','ST-004','ST-005']);
        await page.locator('#mode-toggle').click();await waitMode(page,'通常モード',1);
        assert.equal(await page.locator('tbody strong').textContent(),'商品<&');
        assert.equal(await page.locator('tbody small').textContent(),'A-1');
        assert.equal(await page.locator('#db-notice').isVisible(),false);
      }
      const rows=await rawCounts(page);assert.equal(rows.products.length,1);assert.equal(rows.stocks.length,1);
    }));
    const editInput={code:'A-1',name:'変更後<&',unit:'箱',point:'5'};
    const openEdit=async(page,id)=>{await page.goto(base+'/#product/'+id+'/edit');await page.locator('#product-form').waitFor()};
    await t.test('編集で名称・単位・発注点・version・日時を更新し在庫は不変',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);
      assert.equal(await page.locator('[name=code]').evaluate(e=>e.readOnly),true);
      assert.equal(await page.locator('[name=unit]').evaluate(e=>e.readOnly),false);
      for(const name of ['name','unit','point'])await page.locator(`[name=${name}]`).fill(editInput[name]);
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct&&location.hash==='#inventory');
      const rows=await rawCounts(page);const saved=rows.products[0];
      assert.equal(saved.name,editInput.name);assert.equal(saved.unit,'箱');assert.equal(saved.reorderPoint,5);assert.equal(saved.version,2);assert.ok(saved.updatedAt>p.updatedAt);assert.equal(saved.createdAt,p.createdAt);assert.equal(saved.productCode,p.productCode);assert.deepEqual(rows.stocks,[s]);
      assert.deepEqual(await page.locator('.stat-value').allTextContents(),['1件','1件','1件']);
      await page.locator('#search').fill(editInput.name);assert.equal(await page.locator('tbody tr').count(),1);
      await page.reload();await ready(page);await page.goto(base+'/#product/'+p.id);assert.equal(await page.locator('h1').textContent(),editInput.name);
    }));
    await t.test('保存入口でコード変更・不正入力・古いversion・デモ編集を拒否',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);
      const errors=await page.evaluate(async({p})=>{
        const results=[];for(const [version,input,mode]of [[1,{code:'OTHER',name:'商品',unit:'個',point:'0'},'normal'],[1,{code:p.productCode,name:' ',unit:'個',point:'0'},'normal'],[2,{code:p.productCode,name:'商品',unit:'個',point:'0'},'normal'],[1,{code:p.productCode,name:'商品',unit:'個',point:'0'},'demo']]){
          try{await InventoryDB.updateProduct(p.id,version,input,{mode});results.push('unexpected')}catch(e){results.push(e.message)}
        }return results;
      },{p});
      assert.match(errors[0],/コードは変更できません/);assert.match(errors[1],/商品名/);assert.match(errors[2],/別のタブ/);assert.match(errors[3],/通常モード/);assert.deepEqual(await rawCounts(page),{products:[p],stocks:[s]});
    }));
    await t.test('複数タブ同時編集はversion照合で一方だけ成功',()=>fixture(async(page,context)=>{
      await ready(page);const {p,s}=await seed(page);const other=await context.newPage();await other.goto(base);await ready(other);
      const save=(page,name)=>page.evaluate(async({p,name})=>{try{await InventoryDB.updateProduct(p.id,1,{code:p.productCode,name,unit:'個',point:'0'},{mode:'normal'});return 'ok'}catch(e){return e.message}},{p,name});
      const results=await Promise.all([save(page,'タブA'),save(other,'タブB')]);assert.equal(results.filter(x=>x==='ok').length,1);assert.ok(results.some(x=>x.includes('別のタブ')));
      const rows=await rawCounts(page);assert.equal(rows.products[0].version,2);assert.deepEqual(rows.stocks,[s]);
    }));
    await t.test('他タブ通知で一覧を再取得・編集中フォームは維持し競合を拒否',()=>fixture(async(page,context)=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);const other=await context.newPage();await other.goto(base);await ready(other);
      await openEdit(other,p.id);await other.locator('[name=name]').fill('保持する編集中入力');
      await page.evaluate(({p,editInput})=>InventoryDB.updateProduct(p.id,1,editInput,{mode:'normal'}),{p,editInput});
      await other.waitForFunction(()=>document.querySelector('#db-notice').textContent.includes('別のタブ'));
      assert.equal(await other.locator('[name=name]').inputValue(),'保持する編集中入力');
      await other.getByRole('button',{name:'変更を保存',exact:true}).click();await other.waitForFunction(()=>!savingProduct);
      assert.match(await other.locator('#db-notice').textContent(),/再確認/);assert.equal(await other.locator('[name=name]').inputValue(),'保持する編集中入力');
      assert.equal((await rawCounts(page)).products[0].name,editInput.name);
      await other.goto(base+'/#inventory');await other.waitForFunction(()=>dbState==='ready'&&document.querySelector('tbody strong')?.textContent==='変更後<&');
    }));
    await t.test('通常一覧は登録・編集通知で自動更新しデモは影響を受けない',()=>fixture(async(page,context)=>{
      await ready(page);const other=await context.newPage();await other.goto(base);await ready(other);
      const product=await other.evaluate(input=>InventoryDB.registerProduct(input,{mode:'normal'}),input);
      await page.waitForFunction(()=>document.querySelector('tbody tr')&&dbState==='ready');
      await other.evaluate(({id})=>InventoryDB.updateProduct(id,1,{code:'NEW-1',name:'通知された名前',unit:'箱',point:'3'},{mode:'normal'}),{id:product.id});
      await page.waitForFunction(()=>document.querySelector('tbody strong')?.textContent==='通知された名前');
      await page.locator('#mode-toggle').click();await waitMode(page,'デモモード',5);
      await other.evaluate(({id})=>InventoryDB.updateProduct(id,2,{code:'NEW-1',name:'デモ中の通知',unit:'個',point:'0'},{mode:'normal'}),{id:product.id});
      // 通知配信の処理完了をチャネルの往復で待つ（固定sleepは使わない）。
      await page.evaluate(()=>new Promise(resolve=>{const a=new BroadcastChannel('review-barrier'),b=new BroadcastChannel('review-barrier');b.onmessage=()=>{a.close();b.close();resolve()};a.postMessage('done')}));
      assert.equal(await page.locator('tbody tr').count(),5);assert.equal(await page.locator('#db-notice').isVisible(),false);
      await page.locator('#mode-toggle').click();await waitMode(page,'通常モード',1);assert.equal(await page.locator('tbody strong').textContent(),'デモ中の通知');
    }));
    await t.test('編集putのabortは旧商品・在庫と入力を保持',()=>fixture(async page=>{
      await ready(page);const {p,s}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);await page.locator('[name=name]').fill('失敗しても保持');
      await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const req=put.apply(this,args);req.addEventListener('success',()=>this.transaction.abort());return req}});
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.locator('[name=name]').inputValue(),'失敗しても保持');assert.match(await page.locator('#db-notice').textContent(),/編集を保存できません/);assert.deepEqual(await rawCounts(page),{products:[p],stocks:[s]});
    }));
    for(const moved of [false,true])await t.test('編集完了後の再取得失敗を再保存不要と案内'+(moved?'（移動あり）':''),()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);await page.locator('[name=name]').fill('保存済みの変更');
      await page.evaluate(()=>{const save=InventoryDB.updateProduct;InventoryDB.updateProduct=async(...args)=>{await new Promise(resolve=>window.releaseEdit=resolve);return save(...args)}});
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>savingProduct);
      if(moved){await page.evaluate(()=>location.hash='inventory');await page.waitForFunction(()=>!!document.querySelector('.stats'))}
      await page.evaluate(()=>{InventoryDB.readProducts=()=>Promise.reject(new Error('read'));window.releaseEdit()});await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/編集済み.*再保存せず/);
      if(moved){assert.equal(await page.locator('.stats').count(),0);assert.equal(await page.locator('tbody').count(),0)}else{assert.equal(await page.locator('[name=name]').inputValue(),'保存済みの変更');assert.equal(await page.getByRole('button',{name:'編集済み（再保存不要）'}).isDisabled(),true)}
      assert.equal((await rawCounts(page)).products[0].version,2);
    }));
    await t.test('発注点の編集でアラートと要発注集計を両方向に更新',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);
      await page.evaluate(async id=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction(['stocks','movements'],'readwrite');const req=tx.objectStore('stocks').get(id);req.onsuccess=()=>{const stock=req.result;tx.objectStore('stocks').put({...stock,quantity:5,version:2});tx.objectStore('movements').add({id:crypto.randomUUID(),productId:id,type:'IN',quantity:5,stockBefore:0,stockAfter:5,stockVersionBefore:1,stockVersionAfter:2,productCodeSnapshot:'A-1',productNameSnapshot:'商品<&',unitSnapshot:'個',occurredAt:stock.updatedAt,note:'',actorId:null})};tx.oncomplete=resolve})},p.id);
      await page.reload();await ready(page);assert.deepEqual(await page.locator('.stat-value').allTextContents(),['1件','0件','0件']);
      for(const [point,label,count]of [['5','要発注','1件'],['4','適正在庫','0件']]){
        await openEdit(page,p.id);await page.locator('[name=point]').fill(point);await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct&&location.hash==='#inventory');
        assert.equal(await page.locator('tbody .badge').textContent(),label);assert.equal(await page.locator('.stat-value').nth(1).textContent(),count);assert.equal((await rawCounts(page)).stocks[0].quantity,5);
      }
    }));
    await t.test('通知後の一覧再取得失敗は古い表と集計を残さない',()=>fixture(async(page,context)=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);const other=await context.newPage();await other.goto(base);await ready(other);
      await page.evaluate(()=>InventoryDB.readProducts=()=>Promise.reject(new Error('通知後の読み込み失敗')));
      await other.evaluate(({p,editInput})=>InventoryDB.updateProduct(p.id,1,editInput,{mode:'normal'}),{p,editInput});
      await page.waitForFunction(()=>dbState==='error');assert.equal(await page.locator('.stats').count(),0);assert.equal(await page.locator('tbody').count(),0);assert.match(await page.locator('#db-notice').textContent(),/読み込み失敗/);
    }));
    await t.test('編集保存中の通知が追加再取得で失敗しても保存完了を維持',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);await page.locator('[name=name]').fill('確定した変更');
      await page.evaluate(()=>{
        const save=InventoryDB.updateProduct;InventoryDB.updateProduct=async(...args)=>{await new Promise(resolve=>window.releaseEdit=resolve);return save(...args)};
        const read=InventoryDB.readProducts;window.readCount=0;InventoryDB.readProducts=()=>++window.readCount===1?read():Promise.reject(new Error('通知分の再取得失敗'));
      });
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();
      await page.evaluate(()=>{window.changeSender=new BroadcastChannel('stock-note-products');window.changeSender.postMessage({type:'products-changed'})});await page.waitForFunction(()=>dataDirty);
      await page.evaluate(()=>window.releaseEdit());await page.waitForFunction(()=>!savingProduct&&dbState==='error');
      assert.equal(await page.locator('#save-notice').textContent(),'編集は完了しています。再保存は不要です。');
      assert.match(await page.locator('#db-message').textContent(),/通知分の再取得失敗.*再保存は不要/);
      assert.equal(await page.locator('tbody').count(),0);assert.equal(await page.locator('.stats').count(),0);
      const rows=await rawCounts(page);assert.equal(rows.products[0].name,'確定した変更');assert.equal(rows.products[0].version,2);assert.equal(rows.stocks.length,1);
    }));
    await t.test('保存完了後の読込失敗でも編集中フォーム4項目を保持',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);
      await page.locator('[name=name]').fill('確定した編集');await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct&&location.hash==='#inventory');
      await openEdit(page,p.id);const values={code:'A-1',name:'次の編集中',unit:'箱',point:'8'};
      for(const name of ['name','unit','point'])await page.locator(`[name=${name}]`).fill(values[name]);
      const before=await rawCounts(page);
      await page.evaluate(()=>{window.keptForm=document.querySelector('#product-form');InventoryDB.readProducts=()=>Promise.reject(new Error('背景再取得失敗'));loadNormalProducts()});await page.waitForFunction(()=>dbState==='error');
      assert.match(await page.locator('#db-notice').textContent(),/再保存は不要/);assert.equal(await page.locator('#save-notice').isVisible(),true);
      for(const [name,value]of Object.entries(values))assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
      assert.equal(await page.evaluate(()=>window.keptForm===document.querySelector('#product-form')),true);assert.deepEqual(await rawCounts(page),before);
    }));
    await t.test('通知後も検索・要発注条件を保持し最新データへ再適用',()=>fixture(async(page,context)=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);
      await page.locator('#search').fill('商品<&');await page.locator('#alert-only').check();const other=await context.newPage();await other.goto(base);await ready(other);
      await other.evaluate(p=>InventoryDB.updateProduct(p.id,1,{code:p.productCode,name:'検索対象外',unit:'個',point:'0'},{mode:'normal'}),p);
      await page.waitForFunction(()=>dbState==='ready'&&products[0]?.name==='検索対象外');
      assert.equal(await page.locator('#search').inputValue(),'商品<&');assert.equal(await page.locator('#alert-only').isChecked(),true);assert.equal(await page.locator('tbody tr').count(),0);
      await other.evaluate(p=>InventoryDB.updateProduct(p.id,2,{code:p.productCode,name:'商品<& 最新',unit:'個',point:'0'},{mode:'normal'}),p);
      await page.waitForFunction(()=>dbState==='ready'&&document.querySelector('tbody strong')?.textContent==='商品<& 最新');
      assert.equal(await page.locator('#search').inputValue(),'商品<&');assert.equal(await page.locator('#alert-only').isChecked(),true);
    }));
    await t.test('モード切り替えでは検索条件を初期化しデータを分離',()=>fixture(async page=>{
      await ready(page);await seed(page);await page.reload();await ready(page);await page.locator('#search').fill('商品');await page.locator('#alert-only').check();
      await page.locator('#mode-toggle').click();await waitMode(page,'デモモード',5);
      assert.equal(await page.locator('#search').inputValue(),'');assert.equal(await page.locator('#alert-only').isChecked(),false);
      await page.locator('#search').fill('ST-003');await page.locator('#alert-only').check();await page.locator('#mode-toggle').click();await waitMode(page,'通常モード',1);
      assert.equal(await page.locator('#search').inputValue(),'');assert.equal(await page.locator('#alert-only').isChecked(),false);assert.equal(await page.locator('tbody small').textContent(),'A-1');
    }));
    await t.test('保存結果は再取得成功では消さず新規保存開始・モード切替で解除',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);await openEdit(page,p.id);
      await page.locator('[name=name]').fill('保存1');await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct&&location.hash==='#inventory');
      await page.evaluate(()=>loadNormalProducts());await ready(page);assert.equal(await page.locator('#save-notice').isVisible(),true);
      await openEdit(page,p.id);await page.locator('[name=name]').fill('保存2');
      await page.evaluate(()=>{const save=InventoryDB.updateProduct;InventoryDB.updateProduct=async(...args)=>{await new Promise(resolve=>window.releaseEdit=resolve);return save(...args)}});
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>savingProduct);assert.equal(await page.locator('#save-notice').isVisible(),false);
      await page.evaluate(()=>window.releaseEdit());await page.waitForFunction(()=>!savingProduct);assert.equal(await page.locator('#save-notice').isVisible(),true);
      await page.locator('#mode-toggle').click();await waitMode(page,'デモモード',5);assert.equal(await page.locator('#save-notice').isVisible(),false);
    }));
    for(const editing of [false,true]) await t.test((editing?'編集':'登録')+'でDB不整合を検知したら一覧・詳細キャッシュを無効化し入力保持',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);
      if(editing)await openEdit(page,p.id);else await fillRegistration(page);
      const values=editing?{code:p.productCode,name:'保持する編集',unit:'箱',point:'7'}:input;
      for(const name of editing?['name','unit','point']:Object.keys(values))await page.locator(`[name=${name}]`).fill(values[name]);
      await page.evaluate(async id=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('stocks','readwrite');const get=tx.objectStore('stocks').get(id);get.onsuccess=()=>tx.objectStore('stocks').put({...get.result,quantity:'invalid'});tx.oncomplete=resolve})},p.id);
      const before=await rawCounts(page);
      await page.evaluate(editing=>{const method=editing?'updateProduct':'registerProduct';const save=InventoryDB[method];InventoryDB[method]=async(...args)=>{try{return await save(...args)}catch(error){window.saveErrorCode=error.code;throw error}}},editing);
      await page.getByRole('button',{name:editing?'変更を保存':'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.evaluate(()=>window.saveErrorCode),'DATA');assert.equal(await page.evaluate(()=>dbState),'error');
      for(const [name,value]of Object.entries(values))assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
      assert.doesNotMatch(await page.locator('#status').textContent(),/登録しました|編集しました/);
      await page.getByRole('link',{name:'在庫一覧',exact:true}).click();await page.locator('#db-message').waitFor();
      assert.equal(await page.locator('tbody').count(),0);assert.equal(await page.locator('.stats').count(),0);assert.match(await page.locator('#db-message').textContent(),/不正/);
      await page.goto(base+'/#product/'+p.id);await page.locator('#db-message').waitFor();assert.equal(await page.locator('.stock-number').count(),0);assert.equal(await page.locator('h1').textContent(),'在庫一覧');
      assert.deepEqual(await rawCounts(page),before);
    }));
    for(const editing of [false,true]) await t.test((editing?'編集':'登録')+'の接続失敗はCONNECTIONとして扱い古い一覧を遮断',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);if(editing)await openEdit(page,p.id);else await fillRegistration(page);
      const before=await rawCounts(page);const name=await page.locator('[name=name]').inputValue();
      await page.evaluate(editing=>{const method=editing?'updateProduct':'registerProduct';const save=InventoryDB[method];InventoryDB[method]=async(...args)=>{try{return await save(...args)}catch(error){window.saveErrorCode=error.code;throw error}};InventoryDB.close();window.originalOpen=IDBFactory.prototype.open;IDBFactory.prototype.open=function(){throw new DOMException('blocked','SecurityError')}},editing);
      await page.getByRole('button',{name:editing?'変更を保存':'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.equal(await page.evaluate(()=>window.saveErrorCode),'CONNECTION');assert.equal(await page.evaluate(()=>dbState),'error');assert.equal(await page.locator('[name=name]').inputValue(),name);
      await page.getByRole('link',{name:'在庫一覧',exact:true}).click();await page.locator('#db-message').waitFor();assert.equal(await page.locator('.stats').count(),0);assert.equal(await page.locator('tbody').count(),0);
      await page.evaluate(()=>IDBFactory.prototype.open=window.originalOpen);assert.deepEqual(await rawCounts(page),before);
    }));
    await t.test('重複・version競合は専用codeで拒否しDB全体をエラーにしない',()=>fixture(async page=>{
      await ready(page);const {p}=await seed(page);await page.reload();await ready(page);await fillRegistration(page);await page.locator('[name=code]').fill(p.productCode);
      await page.evaluate(()=>{const save=InventoryDB.registerProduct;InventoryDB.registerProduct=async(...args)=>{try{return await save(...args)}catch(e){window.lastCode=e.code;throw e}}});
      await page.getByRole('button',{name:'商品を登録',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.equal(await page.evaluate(()=>window.lastCode),'DUPLICATE');assert.equal(await page.evaluate(()=>dbState),'ready');assert.match(await page.locator('#db-notice').textContent(),/重複/);
      await openEdit(page,p.id);await page.locator('[name=name]').fill('保持する競合入力');
      await page.evaluate(async p=>{await InventoryDB.updateProduct(p.id,1,{code:p.productCode,name:'先行更新',unit:'個',point:'0'},{mode:'normal'});const save=InventoryDB.updateProduct;InventoryDB.updateProduct=async(...args)=>{try{return await save(...args)}catch(e){window.lastCode=e.code;throw e}}},p);
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.equal(await page.evaluate(()=>window.lastCode),'CONFLICT');assert.equal(await page.evaluate(()=>dbState),'ready');assert.equal(await page.locator('[name=name]').inputValue(),'保持する競合入力');assert.equal((await rawCounts(page)).products[0].name,'先行更新');
      const codes=await page.evaluate(async p=>{const result=[];for(const [input,mode]of [[{code:'ß',name:'商品',unit:'個',point:'0'},'normal'],[{code:'A',name:'商品',unit:'個',point:'0'},'demo']]){try{await InventoryDB.registerProduct(input,{mode})}catch(e){result.push(e.code)}}return result},p);assert.deepEqual(codes,['INPUT','MODE']);
    }));
  } finally {
    if(browser)await browser.close();await new Promise(r=>server.close(r));
  }
});
