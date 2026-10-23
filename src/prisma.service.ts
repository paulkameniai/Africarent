import { randomUUID } from 'crypto';
const isOp=(v:any)=>v&&typeof v==='object'&&!(v instanceof Date)&&['lt','lte','gt','gte','in','not'].some(k=>k in v);
const cmp=(a:any,b:any)=>a instanceof Date?a.getTime()-b.getTime():(a<b?-1:a>b?1:0);
function match(row:any,where:any):boolean{
  return Object.entries(where||{}).every(([k,v]:any)=>{
    if(k==='OR') return v.some((w:any)=>match(row,w));
    if(k==='building') return row.organizationId===v.property.organizationId; // unit->building->property->org shortcut
    if(k.includes('_')&&v&&typeof v==='object') return match(row,v); // compound unique
    if(isOp(v)) return (!('lt' in v)||cmp(row[k],v.lt)<0)&&(!('lte' in v)||cmp(row[k],v.lte)<=0)&&(!('gt' in v)||cmp(row[k],v.gt)>0)&&(!('gte' in v)||cmp(row[k],v.gte)>=0)&&(!('in' in v)||v.in.includes(row[k]));
    return row[k]===v;
  });
}
const defaults:any={payment:{status:'PENDING'},invoice:{paidMinor:0n,status:'OPEN'}};
export class PrismaService{
  t:any={organization:[],lease:[],unit:[],tenant:[],invoice:[],payment:[],paymentAllocation:[],ledgerEntry:[],auditLog:[]};
  constructor(){for(const n of Object.keys(this.t)) (this as any)[n]=this.table(n);}
  table(n:string){const rows=()=>this.t[n];
    const withInc=(r:any,args:any)=>{const o={...r};if(args?.include?.allocations)o.allocations=this.t.paymentAllocation.filter((a:any)=>a.paymentId===r.id);return o;};
    return{
      findFirst:async(a:any)=>{const r=rows().find((x:any)=>match(x,a.where));return r?withInc(r,a):null},
      findUnique:async(a:any)=>{const r=rows().find((x:any)=>match(x,a.where));return r?withInc(r,a):null},
      findUniqueOrThrow:async(a:any)=>{const r=rows().find((x:any)=>match(x,a.where));if(!r)throw new Error('NotFound');return withInc(r,a)},
      findMany:async(a:any)=>rows().filter((x:any)=>match(x,a.where)).map((r:any)=>withInc(r,a)),
      create:async(a:any)=>{const r={id:randomUUID(),createdAt:new Date(),...(defaults[n]||{}),...a.data};rows().push(r);return {...r}},
      createMany:async(a:any)=>{let c=0;for(const d of a.data){if(a.skipDuplicates&&n==='invoice'&&rows().some((x:any)=>x.organizationId===d.organizationId&&x.reference===d.reference))continue;rows().push({id:randomUUID(),createdAt:new Date(),...(defaults[n]||{}),...d});c++}return{count:c}},
      updateMany:async(a:any)=>{let c=0;for(const r of rows()){if(!match(r,a.where))continue;for(const [k,v] of Object.entries(a.data) as any){r[k]=(v&&typeof v==='object'&&'increment' in v)?r[k]+v.increment:v}c++}return{count:c}},
      update:async(a:any)=>{const r=rows().find((x:any)=>match(x,a.where));Object.assign(r,a.data);return r},
    }}
  async $transaction(cb:any){const snap=structuredClone(this.t);try{return await cb(this)}catch(e){this.t=snap;for(const n of Object.keys(this.t))(this as any)[n]=this.table(n);throw e}}
}
