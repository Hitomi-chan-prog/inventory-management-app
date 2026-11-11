const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
test('実入出庫と履歴の保存',async t=>{
 const root=path.resolve(__dirname,'..'),files=['index.html','app.js','styles.css','js/product-validation.js','js/history-validation.js','js/history-query.js','js/movement-validation.js','js/inventory-db.js'];
 const server=http.createServer((req,res)=>{const file=req.url==='/'?'index.html':req.url.slice(1);if(!files.includes(file)){res.writeHead(404).end();return}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true});const base=`http://127.0.0.1:${server.address().port}`;
  const ready=page=>page.waitForFunction(()=>dbState==='ready');
  const fixture=async fn=>{const ctx=await browser.newContext();try{const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await ready(page);const product=await page.evaluate(()=>InventoryDB.registerProduct({code:'A-1',name:'実商品<&',unit:'個',point:'0'},{mode:'normal'}));await page.reload();await ready(page);await fn(page,ctx,product);assert.deepEqual(errors,[])}finally{await ctx.close()}};
  const snapshot=page=>page.evaluate(async()=>{const db=await InventoryDB.open();return new Promise((resolve,reject)=>{const tx=db.transaction(['products','stocks','movements','cancellations']);const requests=['products','stocks','movements','cancellations'].map(s=>tx.objectStore(s).getAll());tx.oncomplete=()=>resolve(requests.map(r=>r.result));tx.onabort=()=>reject(tx.error)})});
  const move=(page,p,type,quantity,operationId)=>page.evaluate(({p,type,quantity,operationId})=>InventoryDB.postMovement({productId:p.id,expectedProductVersion:p.version,type,quantity,note:' 備考<& ',operationId:operationId||crypto.randomUUID()},{mode:'normal'}),{p,type,quantity,operationId});
  await t.test('入庫→出庫→再読込、履歴・前後在庫・version・snapshot・UTC日時',()=>fixture(async(page,ctx,p)=>{
   const a=await move(page,p,'IN',' 005 ');const b=await move(page,p,'OUT','2');assert.equal(a.movement.stockBefore,0);assert.equal(a.movement.stockAfter,5);assert.equal(a.movement.stockVersionBefore,1);assert.equal(a.movement.stockVersionAfter,2);
   assert.equal(b.movement.stockBefore,5);assert.equal(b.movement.stockAfter,3);assert.equal(b.movement.stockVersionAfter,3);assert.equal(b.movement.productNameSnapshot,p.name);assert.equal(b.movement.productCodeSnapshot,p.productCode);assert.equal(b.movement.unitSnapshot,'個');assert.equal(b.movement.note,'備考<&');assert.equal(new Date(b.movement.occurredAt).toISOString(),b.movement.occurredAt);
   await page.reload();await ready(page);assert.equal((await page.evaluate(()=>InventoryDB.readProducts()))[0].stock,3);const rows=await snapshot(page);assert.equal(rows[2].length,2);assert.equal(rows[3].length,0);
  }));
  await t.test('在庫不足を拒否し全数出庫は0になる',()=>fixture(async(page,ctx,p)=>{
   await move(page,p,'IN','5');const before=await snapshot(page);await assert.rejects(()=>move(page,p,'OUT','6'),/不足/);assert.deepEqual(await snapshot(page),before);await move(page,p,'OUT','5');assert.equal((await snapshot(page))[1][0].quantity,0);
  }));
  await t.test('安全整数上限の入庫と加算上限超過の拒否',()=>fixture(async(page,ctx,p)=>{
   await move(page,p,'IN',String(Number.MAX_SAFE_INTEGER));const before=await snapshot(page);await assert.rejects(()=>move(page,p,'IN','1'),/上限/);assert.deepEqual(await snapshot(page),before);
  }));
  await t.test('同じ操作IDの同内容再送は処理済み、異内容再送は拒否',()=>fixture(async(page,ctx,p)=>{
   const id=await page.evaluate(()=>crypto.randomUUID());const first=await move(page,p,'IN','5',id);const before=await snapshot(page);const repeated=await move(page,p,'IN','005',id);assert.equal(first.replayed,false);assert.equal(repeated.replayed,true);assert.deepEqual(await snapshot(page),before);await assert.rejects(()=>move(page,p,'IN','6',id),/異なる内容/);assert.deepEqual(await snapshot(page),before);
  }));
  await t.test('2タブ同時出庫は最新在庫で判定し一方だけ成功',()=>fixture(async(page,ctx,p)=>{
   await move(page,p,'IN','5');const other=await ctx.newPage();await other.goto(base);await ready(other);
   const results=await Promise.allSettled([move(page,p,'OUT','4'),move(other,p,'OUT','4')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.some(r=>r.status==='rejected'&&r.reason.message.includes('不足')));
   const rows=await snapshot(page);assert.equal(rows[1][0].quantity,1);assert.equal(rows[1][0].version,3);assert.equal(rows[2].length,2);
  }));
  await t.test('2タブ同一操作IDの同時再送も1回だけ反映',()=>fixture(async(page,ctx,p)=>{
   const other=await ctx.newPage();await other.goto(base);await ready(other);const id=await page.evaluate(()=>crypto.randomUUID());const results=await Promise.all([move(page,p,'IN','5',id),move(other,p,'IN','5',id)]);assert.equal(results.filter(r=>r.replayed).length,1);const rows=await snapshot(page);assert.equal(rows[1][0].quantity,5);assert.equal(rows[2].length,1);
  }));
  await t.test('確認後の商品version変更を拒否し入力・先行更新を保持',()=>fixture(async(page,ctx,p)=>{
   await page.locator('[data-operation=IN]').click();await page.locator('#quantity').fill('3');await page.locator('#movement-note').fill('保持する備考');const other=await ctx.newPage();await other.goto(base);await ready(other);await other.evaluate(p=>InventoryDB.updateProduct(p.id,p.version,{code:p.productCode,name:'新しい名前',unit:'個',point:'0'},{mode:'normal'}),p);
   await page.waitForFunction(()=>dbState==='ready'&&products[0]?.name==='新しい名前');await page.getByRole('button',{name:'入庫を実行',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.match(await page.locator('#operation-error').textContent(),/商品情報が変更/);assert.equal(await page.locator('#quantity').inputValue(),'3');assert.equal(await page.locator('#movement-note').inputValue(),'保持する備考');assert.equal((await snapshot(page))[2].length,0);
  }));
  for(const target of ['stocks','movements'])for(const cause of ['throw','abort'])await t.test(target+'の'+cause+'では在庫・履歴を両方ロールバック',()=>fixture(async(page,ctx,p)=>{
   const before=await snapshot(page);await page.evaluate(({target,cause})=>{const key=target==='stocks'?'put':'add';const original=IDBObjectStore.prototype[key];IDBObjectStore.prototype[key]=function(...args){if(this.name!==target)return original.apply(this,args);if(cause==='throw')throw new DOMException('test','DataError');const req=original.apply(this,args);req.addEventListener('success',()=>this.transaction.abort());return req}},{target,cause});await assert.rejects(()=>move(page,p,'IN','5'),/失敗/);assert.deepEqual(await snapshot(page),before);
  }));
  await t.test('UIの入庫・出庫、アラート・集計更新、保存中の二重送信抑止',()=>fixture(async(page,ctx,p)=>{
   await page.locator('[data-operation=IN]').click();await page.locator('#quantity').fill('2');await page.locator('#movement-note').fill(' 実入力 ');
   await page.evaluate(()=>{const post=InventoryDB.postMovement;window.originalPost=post;window.calls=0;window.completed=false;InventoryDB.postMovement=async(...args)=>{window.calls++;await new Promise(resolve=>window.releaseOperation=resolve);return post(...args)};const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(args[1]==='readwrite')tx.addEventListener('complete',()=>window.completed=true);return tx};const form=document.querySelector('#operation-form');form.requestSubmit();form.requestSubmit()});await page.waitForFunction(()=>savingProduct);
   assert.equal(await page.getByRole('button',{name:'入庫を実行',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>window.calls),1);assert.equal(await page.locator('#save-notice').isVisible(),false);await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').isVisible(),true);
   await page.evaluate(()=>window.releaseOperation());await page.waitForFunction(()=>!savingProduct&&!document.querySelector('dialog').open);assert.equal(await page.evaluate(()=>window.completed),true);assert.equal(await page.locator('tbody .badge').textContent(),'適正在庫');assert.deepEqual(await page.locator('.stat-value').allTextContents(),['1件','0件','0件']);
   await page.evaluate(()=>InventoryDB.postMovement=window.originalPost);
   await page.locator('[data-operation=OUT]').click();await page.locator('#quantity').fill('3');await page.getByRole('button',{name:'出庫を実行',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.match(await page.locator('#operation-error').textContent(),/不足/);assert.equal(await page.locator('#quantity').inputValue(),'3');
   await page.locator('#quantity').fill('2');await page.getByRole('button',{name:'出庫を実行',exact:true}).click();await page.waitForFunction(()=>!savingProduct&&!document.querySelector('dialog').open);assert.deepEqual(await page.locator('.stat-value').allTextContents(),['1件','1件','1件']);assert.equal((await snapshot(page))[2].length,2);
   await page.reload();await ready(page);assert.equal((await page.evaluate(()=>InventoryDB.readProducts()))[0].stock,0);
  }));
  await t.test('保存完了後の読込失敗は処理完了・再実行不要と案内',()=>fixture(async(page,ctx,p)=>{
   await page.locator('[data-operation=IN]').click();await page.locator('#quantity').fill('2');await page.evaluate(()=>InventoryDB.readProducts=()=>Promise.reject(new Error('read')));await page.getByRole('button',{name:'入庫を実行',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.equal(await page.locator('dialog').isVisible(),false);assert.match(await page.locator('#save-notice').textContent(),/処理は完了.*再実行は不要/);assert.equal(await page.locator('.stats').count(),0);const rows=await snapshot(page);assert.equal(rows[1][0].quantity,2);assert.equal(rows[2].length,1);
  }));
  for(const problem of ['DATA','CONNECTION'])await t.test(problem+'保存失敗時は入力保持・古い集計遮断',()=>fixture(async(page,ctx,p)=>{
   await page.locator('[data-operation=IN]').click();await page.locator('#quantity').fill('2');await page.locator('#movement-note').fill('保持');
   if(problem==='DATA')await page.evaluate(async id=>{const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('stocks','readwrite'),r=tx.objectStore('stocks').get(id);r.onsuccess=()=>tx.objectStore('stocks').put({...r.result,quantity:'bad'});tx.oncomplete=resolve})},p.id);
   else await page.evaluate(()=>{InventoryDB.close();window.originalOpen=IDBFactory.prototype.open;IDBFactory.prototype.open=function(){throw new DOMException('blocked','SecurityError')}});
   await page.getByRole('button',{name:'入庫を実行',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.equal(await page.locator('#quantity').inputValue(),'2');assert.equal(await page.locator('#movement-note').inputValue(),'保持');assert.equal(await page.locator('.stats').count(),0);assert.equal(await page.locator('#save-notice').isVisible(),false);assert.equal(await page.locator('#operation-error').isVisible(),true);
  }));
  await t.test('通常APIでデモ・過去日時・削除商品・不正数量を拒否',()=>fixture(async(page,ctx,p)=>{
   const codes=await page.evaluate(async p=>{const base={productId:p.id,expectedProductVersion:p.version,type:'IN',quantity:'1',note:'',operationId:crypto.randomUUID()};const results=[];for(const [patch,mode]of [[{},'demo'],[{occurredAt:'2020-01-01'},'normal'],[{quantity:'0'},'normal'],[{quantity:'1e3'},'normal']]){try{await InventoryDB.postMovement({...base,...patch},{mode});results.push('unexpected')}catch(e){results.push(e.code)}}const db=await InventoryDB.open();await new Promise(resolve=>{const tx=db.transaction('products','readwrite');tx.objectStore('products').put({...p,deletedAt:p.updatedAt});tx.oncomplete=resolve});try{await InventoryDB.postMovement(base,{mode:'normal'})}catch(e){results.push(e.code)}return results},p);assert.deepEqual(codes,['MODE','INPUT','INPUT','INPUT','NOT_FOUND']);assert.equal((await snapshot(page))[2].length,0);
  }));
  await t.test('デモの入出庫確認で在庫・履歴を書き換えない',()=>fixture(async page=>{
   const before=await snapshot(page);await page.locator('#mode-toggle').click();await page.waitForFunction(()=>demoMode&&document.querySelectorAll('tbody tr').length===5);await page.locator('[data-operation=IN]').first().click();await page.getByRole('button',{name:'デモ内容を確認',exact:true}).click();assert.deepEqual(await snapshot(page),before);
  }));
  await t.test('入出庫通知で別タブの在庫表示を更新',()=>fixture(async(page,ctx,p)=>{
   const other=await ctx.newPage();await other.goto(base);await ready(other);await move(page,p,'IN','5');await other.waitForFunction(()=>dbState==='ready'&&products[0]?.stock===5);assert.match(await other.locator('tbody').textContent(),/5 個/);
  }));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
});
