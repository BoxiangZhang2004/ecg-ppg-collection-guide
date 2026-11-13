import {SOSFilter,estimate} from './pulse-processing.mjs?v=4.3';
import config from './signal-filters.mjs?v=4.3';
export const QUALITY_RULES={version:'raw-screen-20261112-v1',nominalHz:500,rateMin:475,rateMax:525,staleMs:500,railFraction:.01,minSpanADC:8,analysisSamples:5000,warmupSamples:1500};
export class Ring {
  constructor(capacity){this.capacity=capacity;this.data=new Array(capacity);this.size=0;this.cursor=0;}
  push(v){this.data[this.cursor]=v;this.cursor=(this.cursor+1)%this.capacity;this.size=Math.min(this.capacity,this.size+1);}
  array(){const out=[];for(let i=0;i<this.size;i++)out.push(this.data[(this.cursor-this.size+i+this.capacity)%this.capacity]);return out;}
}
const median=x=>{const s=x.slice().sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};
function rawStats(rows,key){const x=rows.map(r=>r[key]).sort((a,b)=>a-b),rail=x.filter(v=>v<=2||v>=1021).length/x.length;return {railFraction:rail,span:x[Math.floor((x.length-1)*.99)]-x[Math.floor((x.length-1)*.01)]};}
function mainsRatio(rows){
  const x=rows.slice(-1000).map(v=>v.e),n=x.length,m=x.reduce((a,b)=>a+b,0)/n;
  const y=x.map((v,i)=>(v-m)*(.5-.5*Math.cos(2*Math.PI*i/(n-1))));
  const power=f=>{const c=2*Math.cos(2*Math.PI*f/500);let a=0,b=0;for(const v of y){const s=v+c*a-b;b=a;a=s;}return Math.max(0,a*a+b*b-c*a*b);};
  let band=0,mains=0;for(let f=5;f<=25;f++)band+=power(f);for(let f=45;f<=65;f++)mains+=power(f);return mains/Math.max(band,1e-9);
}
function qrsSeparation(rows,peaks){
  let sum=0;const envelope=rows.map((r,i)=>{sum+=r.q*r.q;if(i>=40)sum-=rows[i-40].q**2;return sum/40;});
  const background=median(envelope),mad=1.4826*median(envelope.map(v=>Math.abs(v-background))),peak=median(peaks.map(i=>envelope[i]));
  return (peak-background)/Math.max(mad,1e-6);
}
export class QualityMonitor {
  constructor(){this.total=0;this.segment=0;this.lastReceived=null;this.rates=[];this.reset('等待原始数据');}
  reset(reason='信号中断，重新积累'){
    this.ppg=new SOSFilter(config.ppg);this.ecg=new SOSFilter(config.ecg);this.qrs=new SOSFilter(config.qrs);this.count=0;this.raw=new Ring(1000);this.window=new Ring(5000);this.deep=null;this.deepAt=-Infinity;this.segment++;this.reason=reason;
  }
  accept(p,e,now){
    if(this.lastReceived!==null&&now-this.lastReceived>QUALITY_RULES.staleMs)this.reset();
    this.lastReceived=now;this.total++;this.count++;
    const row={p,e,pf:this.ppg.next(p),ef:this.ecg.next(e),q:this.qrs.next(e)};this.raw.push(row);if(this.count>QUALITY_RULES.warmupSamples)this.window.push(row);
    if(this.rates.at(-1)?.at===now)this.rates.at(-1).count=this.total;else this.rates.push({at:now,count:this.total});
    while(this.rates.length>1&&this.rates[1].at<now-5000)this.rates.shift();
    return row;
  }
  snapshot(now){
    const first=this.rates[0],rate=first&&now-first.at>=2000?(this.total-first.count)*1000/(now-first.at):null;
    const base={ok:false,status:'waiting',reason:this.reason,ecg:{ok:false,reason:'判断中'},ppg:{ok:false,reason:'判断中'},rateHz:rate,totalFrames:this.total,segment:this.segment,evaluatedAt:now,rulesVersion:QUALITY_RULES.version};
    if(this.lastReceived===null)return base;
    if(now-this.lastReceived>QUALITY_RULES.staleMs)return {...base,status:'fail',reason:'数据断流，检查连接',ecg:{ok:false,reason:'数据断流'},ppg:{ok:false,reason:'数据断流'}};
    const rows=this.raw.array(),stats=rows.length>=500?{ecg:rawStats(rows,'e'),ppg:rawStats(rows,'p')}:null;
    if(this.window.size===5000&&now-this.deepAt>=1000){
      const full=this.window.array(),r=estimate(full);this.deep={...r,mainsRatio:mainsRatio(full),qrsSeparation:qrsSeparation(full,r.ePeaks??[])};this.deepAt=now;
    }
    const r=this.deep,channels={};
    for(const key of ['ecg','ppg']){
      const st=stats?.[key];let ok=false,reason='判断中';
      if(st?.railFraction>QUALITY_RULES.railFraction)reason='触底或饱和';
      else if(st&&st.span<QUALITY_RULES.minSpanADC)reason='平线或幅度不足';
      else if(r){
        ok=r[key]!==null;
        reason=ok?'初筛通过':key==='ecg'?(r.ecgCV>.2?'心搏检测不稳定':'未找到稳定心搏'):(r.ppgCV>.2?'脉搏检测不稳定':'周期性或脉搏不足');
        if(key==='ecg'&&r.mainsRatio>8){if(r.qrsSeparation<8){ok=false;reason='工频较强，心搏不清晰';}else if(ok)reason='初筛通过，工频偏强';}
      }
      channels[key]={ok,reason,...st};
    }
    const transportOK=rate!==null&&rate>=QUALITY_RULES.rateMin&&rate<=QUALITY_RULES.rateMax;
    const agree=r&&r.ecg!==null&&r.ppg!==null&&Math.abs(r.ecg-r.ppg)<=5;
    const ok=transportOK&&channels.ecg.ok&&channels.ppg.ok&&!!agree;
    const hard=stats&&['ecg','ppg'].some(k=>stats[k].railFraction>QUALITY_RULES.railFraction||stats[k].span<QUALITY_RULES.minSpanADC);
    const reason=ok?'两路通过采集初筛':!transportOK&&rate!==null?'接收速率偏离 500 Hz':!r&&!hard?'积累约 13 秒后判断':!channels.ecg.ok?'ECG '+channels.ecg.reason:!channels.ppg.ok?'PPG '+channels.ppg.reason:!agree?'两路心搏不一致':'接收速率待确认';
    return {...base,status:ok?'pass':!r&&!hard?'waiting':'fail',ok,reason,...channels,diagnostics:r?{mainsRatio:r.mainsRatio,qrsSeparation:r.qrsSeparation,ecgIntervalCV:r.ecgCV,ppgIntervalCV:r.ppgCV,ppgPeriodicity:r.ac.score}:null};
  }
}
