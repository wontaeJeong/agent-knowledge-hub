// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test, expect, vi } from 'vitest';
import { DocumentBody } from './document-navigation';
const deferred=vi.hoisted(()=>({resolve: undefined as undefined|((x:{svg:string})=>void)}));
vi.mock('mermaid',()=>({default:{initialize:vi.fn(),render:vi.fn(()=>new Promise(resolve=>{deferred.resolve=resolve;}))}}));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
test('find has no stale matches after async diagram rendering',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 await act(async()=>{root.render(<DocumentBody content={'# Heading\n```mermaid\nflowchart TD\n A[needle] --> B[end]\n```'} />);await new Promise(r=>setTimeout(r,30));});
 await act(async()=>{const el=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,'needle');el.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(deferred.resolve).toBeTypeOf('function');
 await act(async()=>{deferred.resolve!({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>needle</text></svg>'});});
 const marks=host.querySelectorAll('mark[data-match]').length;const status=host.querySelector('[role=status]')?.textContent;
 console.log(JSON.stringify({marks,status,svg:!!host.querySelector('svg')}));
 expect(status).toBe(marks ? `1 / ${marks}`:'일치 0건');
 await act(async()=>root.unmount());
});
