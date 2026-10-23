import { BadRequestException, Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { PrismaService } from './prisma.service';
import { JwtGuard, OrganizationGuard } from './auth';
class GenerateMonthDto { @IsString() @Matches(/^20\d{2}-(0[1-9]|1[0-2])$/) month!:string; }
@Controller('billing') @UseGuards(JwtGuard,OrganizationGuard)
export class BillingController {
 constructor(private readonly db:PrismaService){}
 // Manual, idempotent monthly generation. Scheduler can call same service in a later phase.
 @Post('generate-month') async generate(@Req() req:any,@Body() dto:GenerateMonthDto){
  if(!['OWNER','MANAGER','ACCOUNTANT'].includes(req.role))throw new ForbiddenException();
  const [year,month]=dto.month.split('-').map(Number);
  const first=new Date(Date.UTC(year,month-1,1));
  const next=new Date(Date.UTC(year,month,1));
  if(Number.isNaN(first.getTime()))throw new BadRequestException('Invalid month');
  const org=await this.db.organization.findUniqueOrThrow({where:{id:req.organizationId}});
  const leases=await this.db.lease.findMany({where:{organizationId:req.organizationId,status:'ACTIVE',startDate:{lt:next},OR:[{endDate:null},{endDate:{gte:first}}]}});
  let created=0,skipped=0;
  for(const lease of leases){
   const reference=`RENT-${dto.month}-${lease.id}`;
   // Compound unique constraint ensures retry/concurrent safety.
   const result=await this.db.invoice.createMany({data:[{organizationId:req.organizationId,leaseId:lease.id,reference,dueDate:first,amountMinor:lease.rentMinor,currency:org.currency}],skipDuplicates:true});
   created+=result.count; skipped+=1-result.count;
  }
  return {month:dto.month,created,skipped,note:'Due date defaults to first of month UTC; lease-specific billing schedules are not implemented'};
 }
}
