const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

test('v1→v2移行と履歴検証のDB連携',async t=>{
 const root=path.resolve(__dirname,'..');
 const files=['index.html','app.js','styles.css','js/product-validation.js','js/history-validation.js','js/history-query.js','js/inventory-db.js','js/movement-validation.js'];
 const server=http.createServer((req,res)=>{const f=req.url==='/'?'index.html':req.url.slice(1);if(!files.includes(f)){res.writeHead(404).end();return}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,f)))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true});
  const base=`http://127.0.0.1:${server.address().port}`;
  const fixture=async fn=>{const ctx=await browser.newContext();try{const page=await ctx.newPage();await page.route('**/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));await page.goto(base);await fn(page,ctx)}finally{await ctx.close()}};
  const legacy=page=>page.evaluate(async()=>{
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('stock-note',1);r.onupgradeneeded=()=>{const p=r.result.createObjectStore('products',{keyPath:'id'});p.createIndex('productCode','productCode',{unique:true});r.result.createObjectStore('stocks',{keyPath:'productId'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
   const now='2026-11-10T00:00:00.000Z',id='00000000-0000-4000-8000-000000000001';
   const p={id,productCode:'OLD-1',name:'既存の商品<&',unit:'個',reorderPoint:2,createdAt:now,updatedAt:now,deletedAt:null,version:3};
   const s={productId:id,quantity:0,updatedAt:now,version:1};
   await new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks'],'readwrite');tx.objectStore('products').add(p);tx.objectStore('stocks').add(s);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();return{p,s};
  });
  const snapshot=page=>page.evaluate(async()=>{const db=await InventoryDB.open();return new Promise(resolve=>{const tx=db.transaction(['products','stocks','movements','cancellations']);const reqs=['products','stocks','movements','cancellations'].map(s=>tx.objectStore(s).getAll());tx.oncomplete=()=>resolve(reqs.map(r=>r.result))})});
  const schema=page=>page.evaluate(async()=>{const db=await InventoryDB.open();const tx=db.transaction([...db.objectStoreNames]);const result={version:db.version,stores:{}};for(const name of db.objectStoreNames){const s=tx.objectStore(name);result.stores[name]={key:s.keyPath,indexes:{}};for(const key of s.indexNames){const i=s.index(key);result.stores[name].indexes[key]={key:i.keyPath,unique:i.unique}}}return result});
  await t.test('v1の全既存レコード・主キー・uniqueインデックスを保持して移行',()=>fixture(async page=>{
   const {p,s}=await legacy(page);await page.evaluate(()=>InventoryDB.open());assert.deepEqual(await snapshot(page),[[p],[s],[],[]]);
   const meta=await schema(page);assert.equal(meta.version,2);assert.deepEqual(meta.stores.products,{key:'id',indexes:{productCode:{key:'productCode',unique:true}}});assert.deepEqual(meta.stores.stocks,{key:'productId',indexes:{}});
   assert.deepEqual(meta.stores.movements,{key:'id',indexes:{occurredAt:{key:'occurredAt',unique:false},productId:{key:'productId',unique:false},productIdOccurredAt:{key:['productId','occurredAt'],unique:false}}});
   assert.deepEqual(meta.stores.cancellations,{key:'id',indexes:{cancelledAt:{key:'cancelledAt',unique:false},movementId:{key:'movementId',unique:true}}});
   assert.equal((await page.evaluate(()=>InventoryDB.readProducts()))[0].name,p.name);
  }));
  await t.test('新規v2作成は空の4ストアだけを作る',()=>fixture(async page=>{const meta=await schema(page);assert.equal(meta.version,2);assert.deepEqual(Object.keys(meta.stores),['cancellations','movements','products','stocks']);assert.deepEqual(await snapshot(page),[[],[],[],[]])}));
  await t.test('更新途中の例外でv1データ・バージョンへロールバック',()=>fixture(async page=>{
   const before=await legacy(page);
   const code=await page.evaluate(async()=>{const original=IDBDatabase.prototype.createObjectStore;IDBDatabase.prototype.createObjectStore=function(name,...args){if(name==='cancellations')throw new DOMException('test','AbortError');return original.call(this,name,...args)};try{await InventoryDB.open();return 'unexpected'}catch(e){return e.code}finally{IDBDatabase.prototype.createObjectStore=original}});assert.equal(code,'SCHEMA');
   const actual=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('stock-note',1);r.onsuccess=()=>resolve(r.result)});const result=await new Promise(resolve=>{const tx=db.transaction(['products','stocks']);const p=tx.objectStore('products').getAll(),s=tx.objectStore('stocks').getAll();tx.oncomplete=()=>resolve({version:db.version,stores:[...db.objectStoreNames],p:p.result,s:s.result})});db.close();return result});
   assert.deepEqual(actual,{version:1,stores:['products','stocks'],p:[before.p],s:[before.s]});
   await page.evaluate(()=>InventoryDB.open());assert.deepEqual(await snapshot(page),[[before.p],[before.s],[],[]]);
  }));
  await t.test('旧タブの接続が更新をブロックし解放後に移行が完了',()=>fixture(async(page,ctx)=>{
   await legacy(page);await page.evaluate(async()=>{window.oldDB=await new Promise(resolve=>{const r=indexedDB.open('stock-note',1);r.onsuccess=()=>resolve(r.result)})});
   const other=await ctx.newPage();await other.route('**/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));await other.goto(base);
   await other.evaluate(()=>{window.notices=[];InventoryDB.subscribe(m=>window.notices.push(m));window.openingV2=InventoryDB.open()});await other.waitForFunction(()=>window.notices.some(m=>m.includes('更新待ち')));
   await page.evaluate(()=>window.oldDB.close());await other.evaluate(()=>window.openingV2);assert.equal((await schema(other)).version,2);
   await other.evaluate(()=>{InventoryDB.subscribe(m=>window.lastNotice=m)});
   await page.evaluate(async()=>{const r=indexedDB.open('stock-note',3);await new Promise(resolve=>r.onsuccess=()=>{r.result.close();resolve()})});await other.waitForFunction(()=>window.lastNotice?.includes('別のタブ'));
  }));
  await t.test('履歴なし非0在庫を検出するが移行時に既存データを補正しない',()=>fixture(async page=>{
   const before=await legacy(page);await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('stock-note',1);r.onsuccess=()=>resolve(r.result)});await new Promise(resolve=>{const tx=db.transaction('stocks','readwrite');const r=tx.objectStore('stocks').getAll();r.onsuccess=()=>tx.objectStore('stocks').put({...r.result[0],quantity:5});tx.oncomplete=resolve});db.close()});
   await assert.rejects(()=>page.evaluate(()=>InventoryDB.readProducts()),/不整合/);const rows=await snapshot(page);assert.deepEqual(rows[0],[before.p]);assert.equal(rows[1][0].quantity,5);assert.deepEqual(rows[2],[]);
  }));
  await t.test('履歴と取消の実DB読込・単位ロック・二重取消unique制約',()=>fixture(async page=>{
   const {p}=await legacy(page);await page.evaluate(()=>InventoryDB.open());
   await page.evaluate(async p=>{const db=await InventoryDB.open(),time='2026-11-10T00:00:01.000Z',later='2026-11-10T00:00:02.000Z';const m={id:'00000000-0000-4000-8000-000000000002',productId:p.id,type:'IN',quantity:5,stockBefore:0,stockAfter:5,stockVersionBefore:1,stockVersionAfter:2,productCodeSnapshot:p.productCode,productNameSnapshot:'当時の名前',unitSnapshot:p.unit,occurredAt:time,note:'',actorId:null};const c={id:'00000000-0000-4000-8000-000000000003',movementId:m.id,productId:p.id,stockBefore:5,stockAfter:0,stockVersionBefore:2,stockVersionAfter:3,reason:'登録取消',cancelledAt:later,actorId:null};await new Promise(resolve=>{const tx=db.transaction(['stocks','movements','cancellations'],'readwrite');tx.objectStore('movements').add(m);tx.objectStore('cancellations').add(c);tx.objectStore('stocks').put({productId:p.id,quantity:0,version:3,updatedAt:later});tx.oncomplete=resolve})},p);
   assert.equal((await page.evaluate(()=>InventoryDB.readProducts()))[0].stock,0);
   await assert.rejects(()=>page.evaluate(p=>InventoryDB.updateProduct(p.id,p.version,{code:p.productCode,name:p.name,unit:'箱',point:'2'},{mode:'normal'}),p),/単位は変更できません/);
   const duplicate=await page.evaluate(async()=>{const db=await InventoryDB.open();return new Promise(resolve=>{const tx=db.transaction('cancellations','readwrite'),r=tx.objectStore('cancellations').getAll();r.onsuccess=()=>tx.objectStore('cancellations').add({...r.result[0],id:crypto.randomUUID()});tx.onabort=()=>resolve(tx.error.name);tx.oncomplete=()=>resolve('unexpected')})});assert.equal(duplicate,'ConstraintError');
   await page.evaluate(async()=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('movements','readwrite'),r=tx.objectStore('movements').getAll();r.onsuccess=()=>tx.objectStore('movements').put({...r.result[0],quantity:9});tx.oncomplete=resolve})});await assert.rejects(()=>page.evaluate(()=>InventoryDB.readProducts()),/不整合/);
  }));
  await t.test('v1の履歴なしversion7をv2へ保持し検証だけをDATAで拒否',()=>fixture(async page=>{
   const {p,s}=await legacy(page);
   await page.evaluate(async id=>{const db=await new Promise(resolve=>{const r=indexedDB.open('stock-note',1);r.onsuccess=()=>resolve(r.result)});await new Promise(resolve=>{const tx=db.transaction('stocks','readwrite'),r=tx.objectStore('stocks').get(id);r.onsuccess=()=>tx.objectStore('stocks').put({...r.result,version:7});tx.oncomplete=resolve});db.close()},p.id);
   await page.evaluate(()=>InventoryDB.open());assert.equal((await schema(page)).version,2);
   const result=await page.evaluate(async()=>{try{await InventoryDB.readProducts();return 'unexpected'}catch(error){return error.code}});assert.equal(result,'DATA');
   assert.deepEqual(await snapshot(page),[[p],[{...s,version:7}],[],[]]);
   await page.evaluate(()=>InventoryDB.close());await page.evaluate(()=>InventoryDB.open());
   assert.deepEqual(await snapshot(page),[[p],[{...s,version:7}],[],[]]);
  }));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
});
