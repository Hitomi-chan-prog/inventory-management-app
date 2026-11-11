const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

test('bfcache復帰時の入力保持', async t => {
  const root = path.resolve(__dirname,'..');
  const files = ['index.html','styles.css','app.js','js/inventory-db.js','js/history-validation.js','js/history-query.js','js/product-validation.js','js/movement-validation.js'];
  const server = http.createServer((req,res) => {
    if (req.url === '/away') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>移動先</title><p>テスト用の別ページ</p>'); return; }
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!files.includes(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(path.join(root,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    // Playwright既定のbfcache無効化だけを解除し、実際の戻る復帰も確認します。
    browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}), headless:true, ignoreDefaultArgs:['--disable-back-forward-cache'] });
    const base = `http://127.0.0.1:${server.address().port}`;
    const fixture = async fn => {
      const context=await browser.newContext();
      try { const page=await context.newPage();await page.goto(base);await page.waitForFunction(()=>dbState==='ready');await fn(page,context); }
      finally { await context.close(); }
    };
    const prepare = async (page, editing) => {
      let product;
      if(editing){product=await page.evaluate(()=>InventoryDB.registerProduct({code:'A',name:'元の商品',unit:'個',point:'0'},{mode:'normal'}));await page.reload();await page.waitForFunction(()=>dbState==='ready')}
      await page.goto(base+'/#product/'+(editing?product.id+'/edit':'new'));
      await page.locator('#product-form').waitFor();
      const values={code:editing?'A':' NEW-1 ',name:'未保存の入力<&',unit:'箱',point:'7'};
      for(const name of editing?['name','unit','point']:Object.keys(values))await page.locator(`[name=${name}]`).fill(values[name]);
      await page.evaluate(()=>{window.keptForm=document.querySelector('#product-form')});
      return {product,values};
    };
    const kept = async(page,values)=>{
      assert.equal(await page.evaluate(()=>window.keptForm===document.querySelector('#product-form')),true);
      for(const[name,value]of Object.entries(values))assert.equal(await page.locator(`[name=${name}]`).inputValue(),value);
    };
    await t.test('登録フォームはpersisted復帰後も4項目を保持',()=>fixture(async page=>{
      const {values}=await prepare(page,false);
      await page.evaluate(()=>{InventoryDB.close();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});
      await page.waitForFunction(()=>dbState==='ready');await kept(page,values);
    }));
    await t.test('編集フォームと開始versionを保持し復帰後の競合を拒否',()=>fixture(async(page,context)=>{
      const {product,values}=await prepare(page,true);
      const other=await context.newPage();await other.goto(base);await other.waitForFunction(()=>dbState==='ready');
      await other.evaluate(p=>InventoryDB.updateProduct(p.id,1,{code:'A',name:'他タブの更新',unit:'個',point:'0'},{mode:'normal'}),product);
      await page.evaluate(()=>{InventoryDB.close();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await page.waitForFunction(()=>dbState==='ready');await kept(page,values);
      await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct);
      assert.match(await page.locator('#db-notice').textContent(),/別のタブ.*再確認/);await kept(page,values);
      assert.equal((await other.evaluate(()=>InventoryDB.readProducts()))[0].name,'他タブの更新');
    }));
    await t.test('復帰後の読込失敗も入力保持し古い一覧を遮断',()=>fixture(async page=>{
      const {values}=await prepare(page,false);
      await page.evaluate(()=>{InventoryDB.readProducts=()=>Promise.reject(new Error('復帰時読み込み失敗'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await page.waitForFunction(()=>dbState==='error');await kept(page,values);
      assert.match(await page.locator('#db-notice').textContent(),/復帰時読み込み失敗/);
      await page.goto(base+'/#inventory');await page.locator('#db-message').waitFor();assert.equal(await page.locator('.stats').count(),0);
    }));
    await t.test('デモ復帰ではDBを読み込まず入力を保持',()=>fixture(async page=>{
      await page.locator('#mode-toggle').click();await page.waitForFunction(()=>demoMode&&document.querySelectorAll('tbody tr').length===5);
      const {values}=await prepare(page,false);
      await page.evaluate(()=>{window.dbReads=0;InventoryDB.readProducts=()=>{window.dbReads++;return Promise.resolve([])};window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});
      await kept(page,values);assert.equal(await page.evaluate(()=>window.dbReads),0);assert.equal(await page.locator('#mode-label').textContent(),'デモモード');
    }));
    for(const editing of [false,true])await t.test('実bfcacheの戻る操作で'+(editing?'編集とversion':'登録入力')+'を保持',()=>fixture(async(page,context)=>{
      const {product,values}=await prepare(page,editing);
      await page.evaluate(()=>{window.bfcacheRestored=false;window.addEventListener('pageshow',event=>{window.bfcacheRestored=event.persisted})});
      await page.goto(base+'/away');
      let other;
      if(editing){other=await context.newPage();await other.goto(base);await other.waitForFunction(()=>dbState==='ready');await other.evaluate(async p=>{
        // BFCache中へのBroadcastChannel配信はキャッシュを退避解除し得るため、
        // このケースだけはDBを直接更新し、復帰時のversion保持を独立検証します。
        const db=await InventoryDB.open();await new Promise((resolve,reject)=>{const tx=db.transaction('products','readwrite');const request=tx.objectStore('products').get(p.id);request.onsuccess=()=>tx.objectStore('products').put({...request.result,name:'離脱中の更新',version:2,updatedAt:new Date().toISOString()});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
      },product)}
      await page.goBack({waitUntil:'commit'});
      await page.waitForFunction(()=>dbState==='ready');
      assert.equal(await page.evaluate(()=>window.bfcacheRestored),true,'実際のpageshow.persistedがtrueであること');
      await kept(page,values);
      if(editing){await page.getByRole('button',{name:'変更を保存',exact:true}).click();await page.waitForFunction(()=>!savingProduct);assert.match(await page.locator('#db-notice').textContent(),/別のタブ/);await kept(page,values)}
    }));
  } finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
});
