async (page) => {
  const daily = [24,31,18,42,35,46,38].map((succeeded,i)=>({day:`2026-10-${24+i}`,succeeded,failed:[1,0,2,1,3,1,2][i]}));
  const usage = {scope:'workspace',from:'2026-10-24T00:00:00Z',to:'2026-10-30T23:59:59Z',timezone:'UTC',total:244,succeeded:234,failed:10,activeUsers:4,publications:3,daily,operations:[{operation:'page.read',total:234,failed:10,averageDurationMs:42.6},{operation:'batch.publish',total:4,failed:0,averageDurationMs:84},{operation:'source.register',total:6,failed:0,averageDurationMs:35}],model:{inputTokens:null,outputTokens:null,cost:null}};
  await page.route('**/api/v1/**',route=>{const path=new URL(route.request().url()).pathname; return route.fulfill({json:path.endsWith('/me')?{principalId:'comparison-fixture',workspaceId:'comparison-space',role:'reviewer',csrfToken:'fixture-csrf'}:path.endsWith('/usage')?usage:path.endsWith('/model')?{configured:false,model:null}:{items:[]}});});
  const results=[];
  for (const width of [390,1440]) for(const phase of ['before','after']) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`http://127.0.0.1:${phase==='before'?4178:4176}/?app=1&comparison=${width}#usage`);
    if(phase==='before') await page.getByRole('button',{name:'사용량',exact:true}).click();
    await page.locator('.usage-report').waitFor();
    const metrics = await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,firstConclusionTop:document.querySelector('.usage-notice').getBoundingClientRect().top,headingTop:document.querySelector('main h1').getBoundingClientRect().top,chartTextSize:getComputedStyle(document.querySelector('.usage-day-detail')).fontSize,tableRowHeight:document.querySelector('.usage-table-scroll tbody tr').getBoundingClientRect().height,tableWidth:document.querySelector('.usage-table-scroll table').getBoundingClientRect().width,navHeight:document.querySelector('.op-nav')?.getBoundingClientRect().height??document.querySelector('.console-sidebar').getBoundingClientRect().height}));
    results.push({phase,...metrics});
    await page.screenshot({path:`docs/pr-assets/agent-console/${phase}-usage-${width}.png`,fullPage:true});
  }
  await page.unroute('**/api/v1/**');
  await page.evaluate(data=>{window.__comparisonVerification=data;},results);
  return results;
}
