import { PrismaService } from './prisma.service';
import { PaymentsController } from './payments';
import { BillingController } from './billing';
import { LeasesController } from './leases';
const results:[string,boolean,string][]=[];
const t=async(name:string,fn:()=>Promise<string|void>)=>{try{const m=await fn();results.push([name,true,m||''])}catch(e:any){results.push([name,false,String(e.message||e)])}};
const eq=(a:any,b:any,w:string)=>{if(String(a)!==String(b))throw new Error(`${w}: expected ${b}, got ${a}`)};
const rejects=async(p:Promise<any>,w:string)=>{try{await p}catch(e:any){return e.name}throw new Error(`${w}: expected rejection`)};
const ORG='orgA',ORGB='orgB';
const req=(role='OWNER',org=ORG)=>({role,organizationId:org,user:{sub:'u1'}});
async function fresh(){
  const db=new PrismaService();
  db.t.organization.push({id:ORG,currency:'XAF'},{id:ORGB,currency:'XAF'});
  db.t.unit.push({id:'u-101',organizationId:ORG,status:'VACANT'},{id:'u-102',organizationId:ORG,status:'VACANT'});
  db.t.tenant.push({id:'t1',organizationId:ORG},{id:'t2',organizationId:ORG});
  const leases=new LeasesController(db as any),billing=new BillingController(db as any),pay=new PaymentsController(db as any);
  return{db,leases,billing,pay};
}
const lease=(unitId:string,tenantId:string)=>({unitId,tenantId,startDate:'2026-01-01',endDate:'2026-12-31',rentMinor:'150000'});
async function withInvoice(){const c=await fresh();await c.leases.create(req() as any,lease('u-101','t1') as any);await c.billing.generate(req() as any,{month:'2026-11'} as any);const inv=c.db.t.invoice[0];return{...c,inv}}
(async()=>{
 process.env.PAYMENTS_SANDBOX_ENABLED='true';process.env.NODE_ENV='development';
 await t('1 Manager assigns tenant to vacant unit',async()=>{const c=await fresh();await c.leases.create(req('MANAGER') as any,lease('u-101','t1') as any);eq(c.db.t.unit[0].status,'OCCUPIED','unit status')});
 await t('2 Second lease on same unit is rejected',async()=>{const c=await fresh();await c.leases.create(req() as any,lease('u-101','t1') as any);eq(await rejects(c.leases.create(req() as any,lease('u-101','t2') as any),'dup lease'),'BadRequestException','err')});
 await t('3 Lease generates the correct invoice (150,000 XAF)',async()=>{const c=await withInvoice();eq(c.inv.amountMinor,150000n,'amount');eq(c.inv.reference.startsWith('RENT-2026-11-'),true,'ref')});
 await t('4 Re-running billing does not duplicate invoices',async()=>{const c=await withInvoice();const r=await c.billing.generate(req() as any,{month:'2026-11'} as any);eq(r.created,0,'created');eq(c.db.t.invoice.length,1,'rows')});
 await t('5 Partial payment updates balance and status',async()=>{const c=await withInvoice();const p:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);await c.pay.confirm(req() as any,p.paymentId);eq(c.inv.paidMinor,50000n,'paid');eq(c.inv.status,'PARTIALLY_PAID','status')});
 await t('6 Two partials complete the invoice (PAID)',async()=>{const c=await withInvoice();for(const [k,a] of [['key-0001-aaaa','50000'],['key-0002-bbbb','100000']]){const p:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:k,amountMinor:a,provider:'ORANGE_MONEY'} as any);await c.pay.confirm(req() as any,p.paymentId)}eq(c.inv.status,'PAID','status');eq(c.inv.paidMinor,150000n,'paid')});
 await t('7 Confirming the same payment twice does not double-credit',async()=>{const c=await withInvoice();const p:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);await c.pay.confirm(req() as any,p.paymentId);const r:any=await c.pay.confirm(req() as any,p.paymentId);eq(r.alreadyProcessed,true,'flag');eq(c.inv.paidMinor,50000n,'paid')});
 await t('8 Same idempotency key returns same payment (no duplicate)',async()=>{const c=await withInvoice();const a:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);const b:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);eq(a.paymentId,b.paymentId,'id');eq(c.db.t.payment.length,1,'rows')});
 await t('9 Reusing a key with a different amount is rejected',async()=>{const c=await withInvoice();await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);eq(await rejects(c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'60000',provider:'MTN_MOMO'} as any),'reuse'),'BadRequestException','err')});
 await t('10 Amount above balance is rejected',async()=>{const c=await withInvoice();eq(await rejects(c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'150001',provider:'MTN_MOMO'} as any),'over'),'BadRequestException','err')});
 await t('11 Pending (unconfirmed) payment leaves invoice unpaid',async()=>{const c=await withInvoice();await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'150000',provider:'MTN_MOMO'} as any);eq(c.inv.paidMinor,0n,'paid');eq(c.inv.status,'OPEN','status')});
 await t('12 Ledger entries balance (debits = credits) and audit written',async()=>{const c=await withInvoice();const p:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);await c.pay.confirm(req() as any,p.paymentId);const d=c.db.t.ledgerEntry.reduce((s:bigint,e:any)=>s+(e.debitMinor||0n),0n),k=c.db.t.ledgerEntry.reduce((s:bigint,e:any)=>s+(e.creditMinor||0n),0n);eq(d,k,'debits vs credits');eq(c.db.t.auditLog.length,1,'audit')});
 await t('13 Two pending full-balance payments cannot both succeed (overpay race)',async()=>{const c=await withInvoice();const a:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'150000',provider:'MTN_MOMO'} as any);const b:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0002-bbbb',amountMinor:'150000',provider:'ORANGE_MONEY'} as any);await c.pay.confirm(req() as any,a.paymentId);await rejects(c.pay.confirm(req() as any,b.paymentId),'2nd confirm');eq(c.inv.paidMinor,150000n,'paid never exceeds amount');eq(c.db.t.payment.find((x:any)=>x.id===b.paymentId).status,'PENDING','rolled back')});
 await t('14 Organization B cannot confirm organization A payment',async()=>{const c=await withInvoice();const p:any=await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);eq(await rejects(c.pay.confirm(req('OWNER',ORGB) as any,p.paymentId),'cross-org'),'BadRequestException','err');eq(c.inv.paidMinor,0n,'paid')});
 await t('15 Organization B cannot list organization A payments',async()=>{const c=await withInvoice();await c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any);const l=await c.pay.list(req('OWNER',ORGB) as any);eq(l.length,0,'rows')});
 await t('16 Tenant and technician roles are forbidden from payments',async()=>{const c=await withInvoice();for(const r of ['TENANT','TECHNICIAN'])eq(await rejects(c.pay.list(req(r) as any),r),'ForbiddenException','err')});
 await t('17 Sandbox is blocked when NODE_ENV=production',async()=>{const c=await withInvoice();process.env.NODE_ENV='production';const n=await rejects(c.pay.initiate(req() as any,{invoiceId:c.inv.id,idempotencyKey:'key-0001-aaaa',amountMinor:'50000',provider:'MTN_MOMO'} as any),'prod');process.env.NODE_ENV='development';eq(n,'ForbiddenException','err')});
 await t('18 Lease creation by an accountant is forbidden',async()=>{const c=await fresh();eq(await rejects(c.leases.create(req('ACCOUNTANT') as any,lease('u-101','t1') as any),'role'),'ForbiddenException','err')});
 const pass=results.filter(r=>r[1]).length;
 for(const [n,ok,m] of results)console.log((ok?'PASS ':'FAIL ')+n+(ok?'':'  -> '+m));
 console.log(`\n${pass}/${results.length} passed`);
})();
