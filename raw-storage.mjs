const DB_NAME='ecg-ppg-raw-20261112';
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('本机保存失败'));tx.onabort=()=>reject(tx.error||new Error('本机保存中断'));});
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
export class RawJournal {
  async open(){
    if(this.db)return this.db;
    this.opening??=new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('sessions',{keyPath:'id'});const chunks=db.createObjectStore('chunks',{keyPath:['sessionId','index']});chunks.createIndex('session','sessionId');};
      req.onsuccess=()=>{this.db=req.result;this.db.onversionchange=()=>this.db.close();resolve(this.db);};
      req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('请关闭另一页面后重试本机保存'));
    });return this.opening;
  }
  async create(meta){
    const db=await this.open(),id=crypto.randomUUID(),session={...meta,id,chunks:0,frames:0,rawBytes:0,status:'recording',lastSavedAt:null};
    const tx=db.transaction('sessions','readwrite'),wait=done(tx);tx.objectStore('sessions').add(session);await wait;return session;
  }
  async get(id){const db=await this.open();return request(db.transaction('sessions').objectStore('sessions').get(id));}
  async list(){const db=await this.open();const rows=await request(db.transaction('sessions').objectStore('sessions').getAll());return rows.sort((a,b)=>b.startedAt-a.startedAt);}
  async append(chunk){
    const db=await this.open(),tx=db.transaction(['sessions','chunks'],'readwrite'),wait=done(tx),store=tx.objectStore('sessions'),req=store.get(chunk.sessionId);
    req.onsuccess=()=>{
      const s=req.result;
      if(!s||s.chunks!==chunk.index){tx.abort();return;}
      tx.objectStore('chunks').add(chunk);store.put({...s,chunks:s.chunks+1,frames:s.frames+chunk.frames,rawBytes:s.rawBytes+chunk.rawBytes,lastSavedAt:Date.now(),lastReceivedAt:chunk.lastReceivedAt,lastSegment:chunk.lastSegment??s.lastSegment});
    };await wait;
  }
  async update(id,patch){const db=await this.open(),tx=db.transaction('sessions','readwrite'),wait=done(tx),store=tx.objectStore('sessions'),req=store.get(id);req.onsuccess=()=>{if(req.result)store.put({...req.result,...patch});else tx.abort();};await wait;}
  async parts(id){
    const db=await this.open(),csv=[],raw=[],quality=[],tx=db.transaction(['sessions','chunks']);
    const meta=request(tx.objectStore('sessions').get(id));
    await new Promise((resolve,reject)=>{const req=tx.objectStore('chunks').index('session').openCursor(IDBKeyRange.only(id));req.onsuccess=()=>{const cursor=req.result;if(!cursor){resolve();return;}const c=cursor.value;csv.push(new Blob([c.csv]));raw.push(...c.bytes);quality.push(...c.quality);cursor.continue();};req.onerror=()=>reject(req.error);});
    return {metadata:await meta,csv,raw,quality};
  }
}
export const CSV_HEADER='source,sample_index,nominal_time_s,host_received_epoch_ms,recording_elapsed_s,ppg_adc,ecg_adc,signal_segment,phase,cuff_interference,quality_state\r\n';
export class RawRecorder {
  constructor(journal,onFault=()=>{}){this.journal=journal;this.onFault=onFault;this.recording=false;this.session=null;this.unsaved=[];this.queue=Promise.resolve();this.resetBuffers();}
  resetBuffers(){this.lines=[];this.bytes=[];this.quality=[];this.bufferFrames=0;this.bufferBytes=0;this.lastReceivedAt=null;this.lastSegment=null;}
  async start(meta){
    if(this.recording)throw new Error('已有采集正在保存');
    this.session=await this.journal.create(meta);this.frames=0;this.savedFrames=0;this.rawBytes=0;this.chunkIndex=0;this.unsaved=[];this.unsavedExported=false;this.fault=null;this.queue=Promise.resolve();this.resetBuffers();this.recording=true;return this.session;
  }
  async resume(id){
    if(this.recording)return;
    this.session=await this.journal.get(id);if(!this.session)throw new Error('未找到本机原始记录');
    this.frames=this.session.frames;this.savedFrames=this.session.frames;this.rawBytes=this.session.rawBytes;this.chunkIndex=this.session.chunks;this.unsaved=[];this.unsavedExported=false;this.fault=null;this.queue=Promise.resolve();this.resetBuffers();
    await this.journal.update(id,{status:'recording',resumedAt:Date.now()});this.recording=true;
  }
  addBytes(bytes){if(this.recording){const copy=bytes.slice();this.bytes.push(copy);this.bufferBytes+=copy.length;this.rawBytes+=copy.length;}}
  addSample(p,e,now,context,segment){
    if(!this.recording)return;
    const elapsed=(now-this.session.startedAt)/1000;
    this.lines.push(`${this.session.source},${this.frames},${(this.frames/500).toFixed(3)},${now},${elapsed.toFixed(3)},${p},${e},${segment},${context.phase},${context.interference?1:0},${context.qualityState}\r\n`);
    this.frames++;this.bufferFrames++;this.lastReceivedAt=now;this.lastSegment=segment;
  }
  addQuality(value){if(this.recording)this.quality.push(value);}
  flush(){
    if(!this.session||(!this.bufferFrames&&!this.bufferBytes&&!this.quality.length))return this.queue;
    const chunk={sessionId:this.session.id,index:this.chunkIndex++,csv:this.lines.join(''),bytes:this.bytes,quality:this.quality,frames:this.bufferFrames,rawBytes:this.bufferBytes,lastReceivedAt:this.lastReceivedAt,lastSegment:this.lastSegment};
    this.resetBuffers();
    this.queue=this.queue.then(async()=>{
      if(this.fault){this.unsaved.push(chunk);return;}
      try{await this.journal.append(chunk);this.savedFrames+=chunk.frames;}catch(error){this.fault=error;this.unsaved.push(chunk);this.recording=false;this.onFault(error);}
    });return this.queue;
  }
  async checkpoint(patch){if(this.session&&!this.fault){await this.flush();if(!this.fault)await this.journal.update(this.session.id,patch);}}
  async stop(patch){this.recording=false;await this.flush();if(!this.fault)await this.journal.update(this.session.id,{...patch,status:'stopped'});}
  async packageParts(id=this.session?.id){
    if(!id)throw new Error('还没有原始数据记录');
    if(id===this.session?.id)await this.flush();
    const parts=await this.journal.parts(id),metadata=parts.metadata;
    if(id===this.session?.id)for(const c of this.unsaved){parts.csv.push(new Blob([c.csv]));parts.raw.push(...c.bytes);parts.quality.push(...c.quality);}
    return {...parts,metadata:{...metadata,unsavedChunksIncluded:id===this.session?.id?this.unsaved.length:0}};
  }
}
