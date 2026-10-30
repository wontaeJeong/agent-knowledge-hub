async (page) => {
  const origin = new URL(page.url()).origin;
  const calls = [], checks = {};
  const identity = {principalId:'fixture-owner',workspaceId:'fixture-managed-space',role:'reviewer',spaceRole:'Admin',canReviewKnowledge:true,personalSpace:false,csrfToken:'fixture-csrf'};
  const space = {id:identity.workspaceId,name:'계약 fixture 공간',ownerId:null,orgId:'fixture-org',organization:'계약 fixture 조직',visibility:'private',role:'Admin',revision:1};
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname; calls.push({path,method:route.request().method()});
    let data = {items:[]};
    if(path.endsWith('/me')) data=identity;
    else if(path.endsWith('/model')) data={configured:false,model:null};
    else if(path==='/api/v1/access') data={managed:true,bootstrapAllowed:false,space,capabilities:{manageSpace:true,manageOrganization:true,triage:true},members:[{principalId:identity.principalId,name:'계약 fixture 사용자',role:'Admin',organizationRole:'owner',paths:['owner']}],teams:[],grants:[],reviewers:[identity.principalId],invitations:[],audit:[]};
    else if(path==='/api/v1/access/spaces')data={items:[space]};
    else if(path==='/api/v1/access/organizations')data={items:[{id:'fixture-org',name:'계약 fixture 조직',role:'owner'}]};
    else if(path==='/api/v1/imports/config') data={personal:false,partSize:262144,maxFileSize:26214400,reviewers:[identity.principalId],canReviewDisclosure:true};
    else if(path==='/api/v1/usage')data={scope:'workspace',from:'2026-10-24T00:00:00Z',to:'2026-10-30T00:00:00Z',timezone:'UTC',total:0,succeeded:0,failed:0,activeUsers:0,publications:0,daily:[],operations:[],model:{inputTokens:null,outputTokens:null,cost:null}};
    return route.fulfill({json:data});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin+'/?app=1&verify=live-access#access');
  await page.getByText('계약 fixture 사용자',{exact:true}).waitFor();
  checks.realAccessManagerRendered=await page.getByRole('heading',{name:'공간 · 접근 멤버',exact:true}).isVisible();
  checks.noMockBoundary=await page.locator('.console-mock-boundary').count()===0;
  await page.locator('a[href="#imports"]').click();
  await page.getByRole('heading',{name:'자료 넣기 · 자동 정리',exact:true}).last().waitFor();
  await page.waitForFunction(()=>document.querySelector('.import-workbench')!==null);
  checks.realImportWorkbenchRendered=await page.locator('.import-workbench input[type=file]').count()>0;
  await page.locator('a[href="#overview"]').click(); await page.locator('.console-metric').first().waitFor();
  await page.getByText('실패율 해당 없음',{exact:false}).waitFor();
  checks.realZeroIsNotMissing=(await page.locator('.console-usage-summary').innerText()).includes('0건 호출');
  checks.noInventedPercent=!(await page.locator('.console-usage-summary').innerText()).includes('100%');
  checks.serverContractsRequested=calls.some(c=>c.path==='/api/v1/access')&&calls.some(c=>c.path==='/api/v1/imports/config');
  checks.noWrites=calls.every(c=>c.method==='GET');
  await page.unroute('**/api/v1/**');
  await page.evaluate(data=>{window.__liveRouteVerification=data;},{checks,calls});
  return {checks,calls};
}
