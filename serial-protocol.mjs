// Both formats have 10-bit ADC values, no checksum, sample number or device timestamp.
export const SERIAL_CONFIG = {baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:65536};
export class AutoFrameParser {
  constructor(onFrame, onFault = () => {}) { this.onFrame=onFrame;this.onFault=onFault;this.protocol=null;this.frames=0;this.invalid=0;this.discarded=0;this.pending=[];this.line=[];this.dropping=false; }
  resetPartial() { this.discarded+=this.pending.length+this.line.length;this.pending=[];this.line=[];this.dropping=false; }
  push(chunk) {
    if(!this.protocol) {
      for(const b of chunk)this.pending.push(b);
      if(this.pending.length>16384){this.discarded+=this.pending.length-16384;this.pending=this.pending.slice(-16384);}
      const text=String.fromCharCode(...this.pending);
      const matches=[...text.matchAll(/(?:^|\n)PPG:(\d{1,4})\tECG:(\d{1,4})\r?(?=\n)/g)].filter(m=>Number(m[1])<=1023&&Number(m[2])<=1023);
      if(matches.length>=3)this.protocol='text';
      if(!this.protocol)for(let i=0;i+18<=this.pending.length;i++){
        let good=true;for(let j=0;j<3;j++){const k=i+6*j;if(this.pending[k]!==170||this.pending[k+1]!==187||this.pending[k+2]*256+this.pending[k+3]>1023||this.pending[k+4]*256+this.pending[k+5]>1023){good=false;break;}}
        if(good){this.protocol='binary';break;}
      }
      if(!this.protocol)return;
      const buffered=this.pending;this.pending=[];this.push(buffered);return;
    }
    if(this.protocol==='text') {
      for(const b of chunk){
        if(b===10){
          const line=this.dropping?'':String.fromCharCode(...this.line),m=/^PPG:(\d{1,4})\tECG:(\d{1,4})\r?$/.exec(line);
          if(m&&Number(m[1])<=1023&&Number(m[2])<=1023)this.emit(Number(m[1]),Number(m[2]));
          else{this.invalid++;this.discarded+=this.line.length+1;this.onFault('文本帧不完整或 ADC 越界');}
          this.line=[];this.dropping=false;
        }else if(this.dropping)this.discarded++;
        else if(this.line.length>=64){this.discarded+=this.line.length+1;this.line=[];this.dropping=true;}
        else this.line.push(b);
      }
      return;
    }
    for(const b of chunk)this.pending.push(b);
    let i=0,desynced=false;
    while(i+1<this.pending.length){
      if(this.pending[i]!==170||this.pending[i+1]!==187){i++;this.discarded++;if(!desynced){this.onFault('二进制帧重新同步');desynced=true;}continue;}
      if(i+6>this.pending.length)break;
      const p=this.pending[i+2]*256+this.pending[i+3],e=this.pending[i+4]*256+this.pending[i+5];
      if(p>1023||e>1023){this.invalid++;this.discarded++;i++;if(!desynced){this.onFault('二进制 ADC 越界');desynced=true;}continue;}
      this.emit(p,e);i+=6;desynced=false;
    }
    this.pending=this.pending.slice(i);
  }
  emit(p,e){this.frames++;this.onFrame(p,e);}
}
export function encodeBinary(p,e){return Uint8Array.of(170,187,p>>8,p&255,e>>8,e&255);}
export function encodeText(p,e){return new TextEncoder().encode(`PPG:${p}\tECG:${e}\r\n`);}
