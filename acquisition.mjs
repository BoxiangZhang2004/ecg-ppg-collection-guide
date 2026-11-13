import {AutoFrameParser,SERIAL_CONFIG,encodeBinary} from './serial-protocol.mjs?v=4.7';
import {QualityMonitor,Ring,QUALITY_RULES} from './signal-quality.mjs?v=4.7';
import {RawJournal,RawRecorder,CSV_HEADER} from './raw-storage.mjs?v=4.7';
import {zipStore} from './zip-store.mjs?v=4.7';
import {detectSerialSupport,serialErrorMessage} from './serial-support.mjs?v=4.7';
export function syntheticSample(n){const t=n/500,phase=(t*75/60)%1,g=(m,s)=>Math.exp(-.5*((phase-m)/s)**2);return [Math.round(450+70*g(.43,.085)+2*Math.sin(2*Math.PI*3*t)),Math.round(512+150*g(.15,.018)-70*g(.19,.022)+40*Math.sin(2*Math.PI*50*t))];}
export class Acquisition {
  constructor({context=()=>({phase:'preview',interference:false,qualityState:'waiting'}),onFault=()=>{},onNotice=()=>{}}={}){
    this.context=context;this.onFault=onFault;this.onNotice=onNotice;this.monitor=new QualityMonitor();this.plot=new Ring(5000);this.source='idle';this.connected=false;this.connecting=false;this.port=null;this.reader=null;this.closing=false;this.demoTimer=null;this.journal=new RawJournal();
    this.recorder=new RawRecorder(this.journal,error=>{this.onFault('storage','原始保存失败，记录已停止：'+error.message);});this.makeParser();this.lastFlush=0;this.lastQualityLog=0;
  }
  makeParser(){this.parser=new AutoFrameParser((p,e)=>{const now=this.chunkTime??Date.now();if(this.recorder.recording&&this.recorder.session.protocol!==this.parser.protocol){const reason='记录中协议发生变化，请导出并新建记录';this.recorder.addQuality({event:'protocol_changed',at:now,from:this.recorder.session.protocol,to:this.parser.protocol});this.recorder.recording=false;this.recorder.fault=new Error(reason);this.onFault('protocol',reason);return;}const filtered=this.monitor.accept(p,e,now);this.plot.push({p,e,pf:filtered.pf,ef:filtered.ef,warm:this.monitor.count>QUALITY_RULES.warmupSamples,at:now,segment:this.monitor.segment});this.recorder.addSample(p,e,now,this.context(),this.monitor.segment);},reason=>{this.monitor.reset(reason);this.recorder.addQuality({event:'parser_resync',reason,at:this.chunkTime??Date.now()});});}
  ingest(bytes,now=Date.now()){this.chunkTime=now;this.recorder.addBytes(bytes);this.parser.push(bytes);}
  async connect(){
    if(this.connecting)return;
    const support=detectSerialSupport();if(!support.supported){this.onNotice(support.message);throw new Error(support.message);}
    if(this.port&&this.connected){if(this.recorder.recording)throw new Error('记录中请先结束采集，再断开设备');await this.disconnect();return;}
    if(this.recorder.recording&&this.source!=='serial')throw new Error('请先结束当前演示记录，再连接设备');
    this.connecting=true;
    try{
      const port=await navigator.serial.requestPort();await port.open(SERIAL_CONFIG);
      this.stopDemo();this.port=port;this.source='serial';this.connected=true;this.monitor.reset('等待设备原始数据');this.makeParser();this.readTask=this.readLoop(port);this.onNotice('已连接，正在自动识别文本 / 二进制协议');
    }catch(error){const message=serialErrorMessage(error);this.onNotice(message);throw new Error(message,{cause:error});}finally{this.connecting=false;}
  }
  async readLoop(port){
    try{while(port.readable&&this.connected){const reader=port.readable.getReader();this.reader=reader;try{while(true){const {value,done}=await reader.read();if(done)break;if(value)this.ingest(value);}}finally{reader.releaseLock();this.reader=null;}if(!this.closing)break;}}
    catch(error){if(!this.closing)this.onFault('connection','串口读取中断：'+error.message);}
    finally{if(this.port===port){this.connected=false;this.port=null;}try{await port.close();}catch{}if(!this.closing)this.onFault('connection','设备已断开，请重新连接；已有原始记录保留');}
  }
  async disconnect(){this.closing=true;this.connected=false;try{await this.reader?.cancel();await this.readTask;}finally{this.reader=null;this.port=null;this.closing=false;}}
  async demo(){
    if(this.recorder.recording&&this.source!=='synthetic')throw new Error('请先结束真实记录，再进入演示');
    if(this.demoTimer)return;
    if(this.port)await this.disconnect();this.source='synthetic';this.connected=true;this.monitor.reset('演示信号积累中');this.makeParser();let n=0,last=Date.now(),fraction=0;
    this.demoTimer=setInterval(()=>{const now=Date.now();fraction+=(now-last)*.5;last=now;const count=Math.min(250,Math.floor(fraction));fraction-=Math.floor(fraction);const bytes=new Uint8Array(count*6);for(let i=0;i<count;i++){const [p,e]=syntheticSample(n++);bytes.set(encodeBinary(p,e),i*6);}if(count)this.ingest(bytes,now);},20);
    this.onNotice('演示信号：当前数据为合成数据，导出也会明确标记');
  }
  stopDemo(){if(this.demoTimer){clearInterval(this.demoTimer);this.demoTimer=null;}}
  snapshot(now=Date.now()){
    const q=this.monitor.snapshot(now);
    if(!this.connected)return {...q,ok:false,status:'fail',reason:this.source==='idle'?'未连接采集板':'数据已断开',source:this.source};
    if(this.recorder.fault)return {...q,ok:false,status:'fail',reason:'原始保存失败，记录已停止',source:this.source};
    return {...q,source:this.source};
  }
  async start(meta){
    if(!this.connected)throw new Error('请先连接采集板，或在“更多”中启用演示信号');
    if(!this.parser.protocol)throw new Error('还未识别到有效原始帧，请检查设备协议和连接');
    const startedAt=Date.now();
    const session=await this.recorder.start({...meta,startedAt,source:this.source,synthetic:this.source==='synthetic',protocol:this.parser.protocol,serialConfig:SERIAL_CONFIG,parserStart:{frames:this.parser.frames,invalidFrames:this.parser.invalid,discardedBytes:this.parser.discarded},qualityRules:QUALITY_RULES,deviceTimestampsAvailable:false,deviceSequenceAvailable:false,timingNote:'nominal_time_s 仅按 500 Hz 帧数计算；host_received_epoch_ms 是电脑接收批次时刻，不能替代硬件采样时间戳。'});
    this.parser.resetPartial();try{navigator.storage?.persist?.().catch(()=>{});}catch{}return session;
  }
  async resume(id){
    if(!this.connected||!this.parser.protocol)throw new Error('请先连接设备，等待识别到有效原始帧');
    const meta=await this.journal.get(id);if(!meta)throw new Error('未找到本机记录');
    if(meta.source!==this.source||meta.protocol!==this.parser.protocol)throw new Error('当前数据源或协议与上次不同，请新建受试者记录');
    await this.recorder.resume(id);this.parser.resetPartial();this.monitor.segment=Math.max(this.monitor.segment,meta.lastSegment??0);this.monitor.reset('恢复连接，重新判断质量');this.recorder.addQuality({event:'recording_resumed_after_gap',at:Date.now(),lastSavedReceivedAt:meta.lastReceivedAt});
  }
  tick(now,q){if(now-this.lastFlush>=1000){this.lastFlush=now;this.recorder.flush();}if(now-this.lastQualityLog>=1000){this.lastQualityLog=now;this.recorder.addQuality(q);}}
  async finish(flow){if(this.recorder.session){await this.recorder.stop({endedAt:flow.endedAt,flow,parserFinal:{frames:this.parser.frames,invalidFrames:this.parser.invalid,discardedBytes:this.parser.discarded}});}}
  async export(id=this.recorder.session?.id,flow=null){
    if(id===this.recorder.session?.id&&flow&&!this.recorder.fault)await this.recorder.checkpoint({flow});
    const parts=await this.recorder.packageParts(id);
    if(!parts.metadata)throw new Error('未找到原始记录');
    const metadata={...parts.metadata,...(id===this.recorder.session?.id&&flow?{flow}:{}),captureFault:id===this.recorder.session?.id?this.recorder.fault?.message??null:null,exportedAt:new Date().toISOString(),qualityScope:'工程初筛；不诊断，不保证血压模型适用性或临床准确性。所有原始数据均保留，干扰段仅标记。'};
    const blob=await zipStore([{name:'samples.csv',blob:new Blob(['\uFEFF',CSV_HEADER,...parts.csv],{type:'text/csv;charset=utf-8'})},{name:'raw.bin',blob:new Blob(parts.raw)},{name:'events.json',blob:new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'})},{name:'quality.json',blob:new Blob([JSON.stringify(parts.quality)],{type:'application/json'})}]);
    const code=(metadata.subjectCode||'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g,'_');return {blob,filename:`${metadata.synthetic?'DEMO_':''}ECG_PPG_${code}_${new Date(metadata.startedAt).toISOString().replace(/[:.]/g,'-')}.zip`,metadata};
  }
}
