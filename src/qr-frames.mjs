export function proofFrames(proof,size=600){
  const json=JSON.stringify(proof);
  const chunks=[];
  for(let offset=0;offset<json.length;offset+=size)chunks.push(json.slice(offset,offset+size));
  if(!chunks.length||chunks.length>100)throw Error('Settlement proof too large for QR');
  return chunks.map((chunk,index)=>JSON.stringify({v:1,kind:'proof-frame',id:proof.id,index,total:chunks.length,chunk}));
}

export class ProofFrameCollector {
  id=null;total=0;parts=[];
  add(raw){
    const frame=typeof raw==='string'?JSON.parse(raw):raw;
    if(frame?.v!==1||frame.kind!=='proof-frame'||typeof frame.id!=='string'||
      !Number.isSafeInteger(frame.index)||!Number.isSafeInteger(frame.total)||
      frame.total<1||frame.total>100||frame.index<0||frame.index>=frame.total||
      typeof frame.chunk!=='string'||frame.chunk.length>1000)throw Error('Invalid proof QR frame');
    if(this.id!==frame.id||this.total!==frame.total){this.id=frame.id;this.total=frame.total;this.parts=Array(frame.total).fill(null);}
    this.parts[frame.index]=frame.chunk;
    const count=this.parts.filter(x=>x!==null).length;
    return {count,total:this.total,proof:count===this.total?JSON.parse(this.parts.join('')):null};
  }
}
