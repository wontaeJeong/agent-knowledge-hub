/** Single-process App1 scheduler; durable outbox deduplication/leases live in OperationsService. */
export class OperationsLoop {
  private running=false;
  private timer?:ReturnType<typeof setTimeout>;
  private active?:Promise<void>;
  constructor(private readonly execute:()=>Promise<unknown>,private readonly options:{intervalMs:number;onError:(error:unknown)=>Promise<void>|void}){
    if(!Number.isSafeInteger(options.intervalMs)||options.intervalMs<1000||options.intervalMs>86400000)throw Error('MONITOR_CONFIGURATION_REQUIRED');
  }
  start(){
    if(this.running)return;this.running=true;
    const cycle=()=>{
      if(!this.running)return;
      this.active=this.execute().then(()=>{},error=>this.options.onError(error)).catch(()=>{/* The original failure remains in the durable alert outbox; never mark delivery successful. */}).finally(()=>{if(this.running)this.timer=setTimeout(cycle,this.options.intervalMs);});
    };
    cycle();
  }
  async stop(){this.running=false;if(this.timer)clearTimeout(this.timer);await this.active;}
}
