const TABLE=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export async function crc32(blob){let crc=0xffffffff;const reader=blob.stream().getReader();try{while(true){const {value,done}=await reader.read();if(done)break;for(const byte of value)crc=TABLE[(crc^byte)&255]^(crc>>>8);}}finally{reader.releaseLock();}return (crc^0xffffffff)>>>0;}
export async function zipStore(entries){
  const local=[],central=[];let offset=0,centralSize=0;
  for(const {name,blob} of entries){
    if(blob.size>0xffffffff)throw new Error('单个文件超过 ZIP 保存上限');
    const filename=new TextEncoder().encode(name),crc=await crc32(blob),head=new Uint8Array(30+filename.length),h=new DataView(head.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,blob.size,true);h.setUint32(22,blob.size,true);h.setUint16(26,filename.length,true);head.set(filename,30);
    local.push(head,blob);
    const directory=new Uint8Array(46+filename.length),d=new DataView(directory.buffer);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,blob.size,true);d.setUint32(24,blob.size,true);d.setUint16(28,filename.length,true);d.setUint32(42,offset,true);directory.set(filename,46);
    central.push(directory);centralSize+=directory.length;offset+=head.length+blob.size;
    if(offset>0xffffffff)throw new Error('采集包超过 ZIP 保存上限');
  }
  const end=new Uint8Array(22),d=new DataView(end.buffer);d.setUint32(0,0x06054b50,true);d.setUint16(8,entries.length,true);d.setUint16(10,entries.length,true);d.setUint32(12,centralSize,true);d.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
