import {zlibSync,unzlibSync,strToU8,strFromU8} from 'fflate';
import {sha256} from 'ethers';
const limit=65536,partSize=480;
export function makeFrames(object){
  const raw=strToU8(JSON.stringify(object));
  if(raw.length>limit)throw Error('Receipt exceeds proof budget');
  const bytes=zlibSync(raw),body=btoa(String.fromCharCode(...bytes)),id=sha256(bytes).slice(2,18);
  const n=Math.ceil(body.length/partSize);
  return Array.from({length:n},(_,i)=>['BC1',id,raw.length,i,n,body.slice(i*partSize,(i+1)*partSize)].join('|'));
}
export function collector(){
  let key='',parts=new Map();
  return function receive(text){
    if(!text.startsWith('BC1|'))return {value:text};
    const [prefix,id,length,pos,total,part,...rest]=text.split('|');
    const n=Number(total),i=Number(pos),size=Number(length);
    if(rest.length||!/^\w{16}$/.test(id)||!Number.isInteger(n)||n<1||n>190||!Number.isInteger(i)||i<0||i>=n||
      !Number.isInteger(size)||size<1||size>limit||!part||part.length>partSize)throw Error('Invalid QR frame');
    const group=[prefix,id,length,total].join('|');if(group!==key){parts=new Map();key=group;}parts.set(i,part);
    if(parts.size<n)return {progress:parts.size+'/'+n};
    const encoded=Array.from({length:n},(_,j)=>parts.get(j)).join('');
    const packed=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    if(sha256(packed).slice(2,18)!==id)throw Error('Damaged QR receipt');
    return {value:strFromU8(unzlibSync(packed,{out:new Uint8Array(size)}))};
  };
}
