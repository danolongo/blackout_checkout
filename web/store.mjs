const opening=new Promise((resolve,reject)=>{
  const request=indexedDB.open('blackout-checkout',1);
  request.onupgradeneeded=()=>{for(const name of ['orders','settings'])request.result.createObjectStore(name);};
  request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);
});
export async function get(store,key){
  const db=await opening;
  return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
export async function save(store,key,value){
  const db=await opening;
  return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,key);
    t.oncomplete=resolve;t.onerror=()=>reject(t.error);});
}
// Read, check and write inside one transaction so two scans or tabs cannot both change the same order.
async function update(id,status,change,failure){
  const db=await opening;
  return new Promise((resolve,reject)=>{const t=db.transaction('orders','readwrite'),s=t.objectStore('orders');
    const r=s.get(id);let next;
    r.onsuccess=()=>{if(!r.result||r.result.status!==status){t.abort();return;}next={...r.result,...change};s.put(next,id);};
    t.oncomplete=()=>resolve(next);t.onabort=()=>reject(Error(failure));t.onerror=()=>reject(t.error);
  });
}
export function consume(order,bundle,details={}){
  return update(order.id,'open',{...details,status:'paid',bundle},'Order already used or unknown');
}
export function reconciled(id,reconciliation){
  return update(id,'paid',{reconciliation},'Only accepted sales can be reconciled');
}
export async function allOrders(){
  const db=await opening;
  return new Promise((resolve,reject)=>{const r=db.transaction('orders').objectStore('orders').getAll();
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
