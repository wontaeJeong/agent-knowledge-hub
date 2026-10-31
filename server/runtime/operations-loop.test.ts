import {test,expect,vi,afterEach} from 'vitest';
import {OperationsLoop} from './operations-loop';
afterEach(()=>vi.useRealTimers());
test('operational monitor starts immediately, never overlaps an outstanding delivery, and drains on stop',async()=>{
  vi.useFakeTimers();let calls=0,finish:(()=>void)|undefined;
  const loop=new OperationsLoop(async()=>{calls++;await new Promise<void>(resolve=>{finish=resolve;});},{intervalMs:1000,onError:()=>{}});
  loop.start();expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(10000);expect(calls).toBe(1);
  const stopped=loop.stop();finish!();await stopped;await vi.advanceTimersByTimeAsync(10000);expect(calls).toBe(1);
});
test('monitor errors remain reported errors and the next configured cycle retries',async()=>{
  vi.useFakeTimers();const failures:unknown[]=[];let calls=0;
  const loop=new OperationsLoop(async()=>{calls++;if(calls===1)throw Error('DELIVERY_FAILED');},{intervalMs:1000,onError:error=>{failures.push(error);}});
  loop.start();await vi.advanceTimersByTimeAsync(0);expect(failures).toHaveLength(1);expect(calls).toBe(1);await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(2);await loop.stop();
});
