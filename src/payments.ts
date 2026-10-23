import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, Matches } from 'class-validator';
import { PrismaService } from './prisma.service';
import { JwtGuard, OrganizationGuard } from './auth';

class InitiatePaymentDto {
  @IsUUID() invoiceId!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{8,100}$/) idempotencyKey!: string;
  @IsString() @Matches(/^[1-9]\d*$/) amountMinor!: string;
  @IsString() @Matches(/^(MTN_MOMO|ORANGE_MONEY)$/) provider!: string;
}
const money = (value: bigint) => value.toString();
@Controller('payments') @UseGuards(JwtGuard, OrganizationGuard)
export class PaymentsController {
  constructor(private readonly db: PrismaService) {}
  private allow(role:string) { if (!['OWNER','MANAGER','ACCOUNTANT'].includes(role)) throw new ForbiddenException(); }

  @Get() async list(@Req() req:any) {
    this.allow(req.role);
    const payments=await this.db.payment.findMany({where:{organizationId:req.organizationId},orderBy:{createdAt:'desc'},take:100});
    return payments.map(p=>({...p,amountMinor:money(p.amountMinor)}));
  }

  // Sandbox only: creates an intent, never contacts MTN or Orange.
  @Post('sandbox/initiate') async initiate(@Req() req:any,@Body() dto:InitiatePaymentDto) {
    this.allow(req.role);
    if (process.env.PAYMENTS_SANDBOX_ENABLED !== 'true' || process.env.NODE_ENV==='production') throw new ForbiddenException('Sandbox disabled');
    const amount=BigInt(dto.amountMinor);
    const invoice=await this.db.invoice.findFirst({where:{id:dto.invoiceId,organizationId:req.organizationId},include:{lease:true}});
    if(!invoice || invoice.status==='VOID' || invoice.status==='PAID') throw new BadRequestException('Open invoice not found');
    if (amount>invoice.amountMinor-invoice.paidMinor) throw new BadRequestException('Amount exceeds balance');
    const existing=await this.db.payment.findUnique({where:{organizationId_idempotencyKey:{organizationId:req.organizationId,idempotencyKey:dto.idempotencyKey}},include:{allocations:true}});
    if(existing) {
      if(existing.amountMinor!==amount || existing.provider!==dto.provider || existing.allocations[0]?.invoiceId!==dto.invoiceId) throw new BadRequestException('Idempotency key reused with different details');
      return {paymentId:existing.id,status:existing.status,sandbox:true};
    }
    const payment=await this.db.$transaction(async tx=>{
      const p=await tx.payment.create({data:{organizationId:req.organizationId,provider:dto.provider,idempotencyKey:dto.idempotencyKey,amountMinor:amount,currency:invoice.currency}});
      await tx.paymentAllocation.create({data:{paymentId:p.id,invoiceId:invoice.id,amountMinor:amount}});
      return p;
    });
    return {paymentId:payment.id,status:'PENDING',sandbox:true,notice:'No Mobile Money request has been sent'};
  }

  // Explicit manager-triggered simulation, NOT a production provider webhook.
  @Post('sandbox/:paymentId/confirm') async confirm(@Req() req:any,@Param('paymentId') paymentId:string) {
    this.allow(req.role);
    if (process.env.PAYMENTS_SANDBOX_ENABLED !== 'true' || process.env.NODE_ENV==='production') throw new ForbiddenException('Sandbox confirmation disabled');
    return this.db.$transaction(async tx=>{
      const payment=await tx.payment.findFirst({where:{id:paymentId,organizationId:req.organizationId},include:{allocations:true}});
      if(!payment) throw new BadRequestException('Payment not found');
      if(payment.status==='SUCCEEDED') return {paymentId,status:'SUCCEEDED',sandbox:true,alreadyProcessed:true};
      if(payment.status!=='PENDING' || payment.allocations.length!==1) throw new BadRequestException('Payment cannot be confirmed');
      const allocation=payment.allocations[0];
      const invoice=await tx.invoice.findFirst({where:{id:allocation.invoiceId,organizationId:req.organizationId}});
      if(!invoice || invoice.currency!==payment.currency || invoice.status==='VOID') throw new BadRequestException('Invoice mismatch');
      // Conditional write ensures only one concurrent confirmation can succeed.
      const claimed=await tx.payment.updateMany({where:{id:payment.id,status:'PENDING'},data:{status:'SUCCEEDED',providerReference:`SANDBOX-${payment.id}`}});
      if(claimed.count!==1) throw new BadRequestException('Payment was already processed');
      const updated=await tx.invoice.updateMany({where:{id:invoice.id,organizationId:req.organizationId,paidMinor:{lte:invoice.amountMinor-allocation.amountMinor}},data:{paidMinor:{increment:allocation.amountMinor}}});
      if(updated.count!==1) throw new BadRequestException('Invoice balance changed; reconcile before retry');
      const current=await tx.invoice.findUniqueOrThrow({where:{id:invoice.id}});
      await tx.invoice.update({where:{id:invoice.id},data:{status:current.paidMinor===current.amountMinor?'PAID':'PARTIALLY_PAID'}});
      const group=`SANDBOX-${payment.id}`;
      await tx.ledgerEntry.createMany({data:[
        {organizationId:req.organizationId,transactionGroup:group,account:'SANDBOX_CLEARING',debitMinor:allocation.amountMinor,currency:payment.currency},
        {organizationId:req.organizationId,transactionGroup:group,account:'RENT_RECEIVABLE',creditMinor:allocation.amountMinor,currency:payment.currency}
      ]});
      await tx.auditLog.create({data:{organizationId:req.organizationId,actorId:req.user.sub,action:'SANDBOX_PAYMENT_CONFIRMED',entity:'Payment',entityId:payment.id}});
      return {paymentId,status:'SUCCEEDED',sandbox:true,invoiceId:invoice.id,invoicePaidMinor:money(current.paidMinor),invoiceStatus:current.paidMinor===current.amountMinor?'PAID':'PARTIALLY_PAID'};
    });
  }
}
