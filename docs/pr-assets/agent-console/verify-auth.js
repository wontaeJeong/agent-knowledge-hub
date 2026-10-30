async (page) => {
  const origin = new URL(page.url()).origin;
  const results = {};
  const identity = {principalId:'fixture-human',workspaceId:'fixture-space',role:'reviewer',csrfToken:'fixture-csrf'};
  const routes = async (route, overrides = {}) => {
    const path = new URL(route.request().url()).pathname;
    if (overrides[path]) return overrides[path](route);
    const data = path.endsWith('/me') ? identity : path.endsWith('/model') ? {configured:false,model:null} : {items: path.endsWith('/pages') ? [{id:'protected',title:'protected-fixture-title',summary:'fixture',content:'protected-fixture-body',version:1}] : []};
    return route.fulfill({json:data});
  };
  let release, started;
  const gate = new Promise(resolve => {release = resolve;});
  const pending = new Promise(resolve => {started = resolve;});
  await page.route('**/api/v1/**', route => routes(route, {'/api/v1/usage': async route => {started(); await gate; return route.fulfill({status:401,json:{code:'UNAUTHENTICATED'}});}}));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/?app=1&scenario=late401#overview');
  await pending;
  await page.locator('a[href="#knowledge"]').click();
  await page.getByText('protected-fixture-title',{exact:true}).waitFor();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/usage');
  release(); await response;
  await page.waitForFunction(() => !document.body.innerText.includes('protected-fixture-title'), {timeout:1500}).catch(()=>{});
  results.late401ClearsProtected = await page.getByRole('heading',{name:'조직 계정으로 로그인'}).isVisible();
  await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/**', route => routes(route, {'/api/v1/sources':route=>route.fulfill({status:500,json:{code:'INTERNAL_ERROR'}}),'/api/v1/usage':route=>route.fulfill({status:500,json:{code:'INTERNAL_ERROR'}})}));
  await page.goto(origin+'/?app=1&scenario=load-failure#overview');
  await page.getByRole('alert').first().waitFor();
  await page.getByText('요청을 완료하지 못했습니다.',{exact:true}).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('인증 상태와 서버 지식')).catch(()=>{});
  results.failedCollectionsDoNotRenderZero = await page.locator('.console-metric').count() === 0;
  results.failedCollectionsOfferRetry = await page.getByRole('button',{name:'다시 연결',exact:true}).isVisible();
  await page.unroute('**/api/v1/**');
  return results;
}
