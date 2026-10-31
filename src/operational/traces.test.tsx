import {test,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {TracePanel,tracePath} from './traces';
import {OperationalApi} from './api';
test('trace navigation accepts only opaque request identifiers, never arbitrary URLs',()=>{
  expect(tracePath('request-one')).toBe('/traces/request-one');
  for(const id of ['https://other.invalid','../private','a/b',''])expect(()=>tracePath(id)).toThrow();
});
test('unqueried execution telemetry remains unknown, not zero or confirmed provider success',()=>{
  const html=renderToStaticMarkup(<TracePanel api={new OperationalApi()}/>);
  expect(html).toContain('요청 → 작업 → 모델 실행 추적');expect(html).toContain('아직 조회하지 않았습니다');expect(html).not.toContain('type="password"');expect(html).not.toContain('0 토큰');
});
