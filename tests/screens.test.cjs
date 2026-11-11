// テスト専用依存: Playwright。アプリの実行には不要です。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
test('モード分離・入力・安全表示・レスポンシブ表示', async () => {
  const root = path.resolve(__dirname, '..');
  const allowed = ['index.html', 'app.js', 'styles.css', 'js/product-validation.js', 'js/inventory-db.js','js/history-validation.js','js/history-query.js','js/movement-validation.js'];
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!allowed.includes(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless:true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.waitForFunction(() => dbState === 'ready');
    assert.equal(await page.locator('#mode-label').textContent(), '通常モード');
    assert.equal(await page.locator('tbody tr').count(), 0);
    // 通常モードは関数側にも防御があることを確認。
    await page.evaluate(() => openOperation({ dataset:{operation:'IN', product:'p1'} }));
    assert.equal(await page.locator('dialog').isVisible(), false);
    await page.locator('#mode-toggle').click();
    assert.equal(await page.locator('tbody tr').count(), 5);
    await page.locator('#search').fill('ST-003');
    assert.match(await page.locator('tbody').innerText(), /要発注/);
    await page.locator('#search').fill('');
    for (const type of ['IN', 'OUT']) {
      await page.locator(`[data-operation=${type}]`).first().click();
      assert.equal(await page.locator('dialog').isVisible(), true);
      await page.keyboard.press('Escape');
    }
    await page.goto(base + '/#history');
    await page.locator('[data-movement=m1]').click();
    await page.locator('#cancel-reason').fill(' ');
    await page.getByRole('button',{name:'デモ内容を確認',exact:true}).click();
    assert.equal(await page.locator('dialog').isVisible(),true);
    await page.keyboard.press('Escape');
    await page.goto(base + '/#product/new');
    for (const [key, value] of Object.entries({code:' st-009 ',name:' 商品 ',unit:'個',point:'0'})) await page.locator(`[name=${key}]`).fill(value);
    await page.locator('#product-form button[type=submit]').click();
    assert.equal(await page.locator('[name=code]').inputValue(),'ST-009');
    assert.match(await page.locator('#status').innerText(), /保存していません/);
    await page.locator('[name=name]').fill('　 ');
    assert.equal(await page.locator('#status').textContent(),'');
    await page.locator('#product-form button[type=submit]').click();
    assert.equal(await page.locator('[name=name]').getAttribute('aria-invalid'),'true');
    // テストだけでメモリ上の仮データを差し替え、全表示経路を検証。
    const attack = '<img src=x onerror="window.xss=1">"<&';
    await page.evaluate(value => { demoProducts[0].name=value; demoProducts[0].code=value; demoProducts[0].unit=value; }, attack);
    for (const route of ['inventory','product/p1','product/p1/edit','history']) {
      await page.goto(base + '/#' + route);
      assert.equal(await page.locator('#screen img').count(),0);
      assert.equal(await page.evaluate(() => window.xss),undefined);
    }
    assert.equal(await page.locator('#screen').innerText().then(t=>t.includes(attack)),true);
    await page.goto(base+'/#product/p1/edit');
    assert.equal(await page.locator('[name=name]').inputValue(),attack);
    await page.goto(base+'/#inventory');
    await page.locator('[data-operation=IN]').first().click();
    assert.equal(await page.locator('dialog img').count(),0);
    await page.keyboard.press('Escape');
    // 画面幅の検証は通常の仮データへ戻して実施。
    await page.reload();
    await page.locator('#mode-toggle').click();
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:850});
      for(const route of ['inventory','product/new','product/p1','product/p1/edit','history']) {
        await page.goto(base+'/#'+route);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}: ${route}`);
      }
    }
    await page.locator('#mode-toggle').click();
    await page.waitForFunction(()=>location.hash==='#inventory' && dbState === 'ready' && document.querySelector('tbody'));
    assert.equal(await page.locator('tbody tr').count(),0);
    assert.equal(await page.evaluate(()=>localStorage.length),0);
    assert.deepEqual(await page.evaluate(async()=>await InventoryDB.readProducts()),[]);
    assert.deepEqual(errors,[]);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('レビュー指摘のブラウザ再発防止', async t => {
  const root = path.resolve(__dirname, '..');
  const allowed = ['index.html', 'app.js', 'styles.css', 'js/product-validation.js', 'js/inventory-db.js','js/history-validation.js','js/history-query.js','js/movement-validation.js'];
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!allowed.includes(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless:true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    const reset = async () => { await page.goto(base); await page.reload(); await page.waitForFunction(() => dbState === 'ready'); };
    for (const name of ['A&B', 'A"B', "A'B", 'A<B', 'A>B']) {
      await t.test(`商品名 ${name} を元の文字列で検索`, async () => {
        await reset();
        await page.locator('#mode-toggle').click();
        await page.evaluate(name => { demoProducts[0].name = name; renderInventoryTable(); }, name);
        await page.locator('#search').fill(name);
        assert.equal(await page.locator('tbody tr').count(), 1);
        assert.equal(await page.locator('tbody strong').textContent(), name);
      });
    }
    await t.test('発注点の丸めと非ASCIIコードを画面から拒否', async () => {
      await reset();
      await page.goto(base + '/#product/new');
      for (const [name, value] of Object.entries({ code:'ß', name:'商品', unit:'個', point:'1.0000000000000001' })) await page.locator(`[name=${name}]`).fill(value);
      await page.locator('#product-form button[type=submit]').click();
      assert.equal(await page.locator('[name=code]').getAttribute('aria-invalid'), 'true');
      assert.equal(await page.locator('[name=point]').getAttribute('aria-invalid'), 'true');
      assert.doesNotMatch(await page.locator('#status').textContent(), /入力内容を確認しました/);
    });
    await t.test('数値フィールドへ混入したHTMLを全画面で実行しない', async () => {
      await reset();
      await page.locator('#mode-toggle').click();
      const attack = '"><img src=x onerror="window.numericXss=1">';
      await page.evaluate(attack => {
        for (const p of demoProducts) { p.stock = attack; p.point = attack; }
        for (const m of demoMovements) { m.quantity = attack; m.before = attack; m.after = attack; }
        for (const c of demoCancellations) { c.before = attack; c.after = attack; }
      }, attack);
      const safe = async selector => {
        assert.equal(await page.locator(`${selector} img`).count(), 0);
        assert.equal(await page.evaluate(() => window.numericXss), undefined);
      };
      for (const route of ['inventory', 'product/p1', 'product/p1/edit', 'history']) {
        await page.goto(base + '/#' + route);
        await safe('#screen');
      }
      for (const operation of ['IN', 'OUT', 'CANCEL']) {
        await page.goto(base + '/#' + (operation === 'CANCEL' ? 'history' : 'inventory'));
        await page.locator(operation === 'CANCEL' ? '[data-movement=m1]' : `[data-operation=${operation}]`).first().click();
        await safe('dialog');
        await page.keyboard.press('Escape');
      }
    });
    await t.test('通常モードの未知商品IN・OUTと未知履歴CANCELの直接呼び出しを拒否', async () => {
      await reset();
      for (const operation of ['IN', 'OUT', 'CANCEL']) {
        await page.evaluate(operation => openOperation({ dataset:{ operation, product:'p1', movement:'m1' } }), operation);
        assert.equal(await page.locator('dialog').isVisible(), false);
        assert.match(await page.locator('#status').textContent(), /見つかりません/);
      }
    });
    await t.test('通常モードからデモ商品の詳細・編集URLへアクセスできない', async () => {
      await reset();
      for (const route of ['product/p1', 'product/p1/edit']) {
        await page.goto(base + '/#' + route);
        await page.waitForFunction(() => dbState === 'ready');
        assert.equal(await page.locator('h1').textContent(), '画面が見つかりません');
        assert.equal(await page.locator('[data-operation]').count(), 0);
        assert.equal(await page.locator('#product-form').count(), 0);
      }
    });
    await t.test('モード切り替えをキャンセルすると両方向で入力とモードを維持', async () => {
      await reset();
      for (const mode of ['通常モード', 'デモモード']) {
        await page.goto(base + '/#product/new');
        await page.locator('[name=name]').fill('保持する入力');
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#mode-toggle').click();
        assert.equal(await page.locator('#mode-label').textContent(), mode);
        assert.equal(await page.locator('[name=name]').inputValue(), '保持する入力');
        assert.equal(await page.evaluate(() => location.hash), '#product/new');
        await page.goto(base + '/#inventory');
        await page.locator('#mode-toggle').click();
      }
    });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(await page.evaluate(() => InventoryDB.readProducts()), []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
