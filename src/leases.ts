import {Body,Controller,Get,Post,Req,UseGuards,BadRequestException,ForbiddenException,Param} from '@nestjs/common';
import {IsISO8601,IsString,IsUUID,Matches} from 'class-validator';
import {PrismaService} from './prisma.service';
import {JwtGuard,OrganizationGuard} from './auth';
class CreateLeaseDto { @IsUUID() unitId!:string; @IsUUID() tenantId!:string; @IsISO8601() startDate!:string; @IsISO8601() endDate!:string; @IsString() @Matches(/^[1-9]\d*$/) rentMinor!:string; }
@Controller('leases') @UseGuards(JwtGuard,OrganizationGuard)
export class LeasesController {
 constructor(private db:PrismaService){}
 @Get() async list(@Req() req:any){const rows=await this.db.lease.findMany({where:{organizationId:req.organizationId},include:{tenant:{select:{id:true,fullName:true}},unit:{select:{id:true,number:true}}},orderBy:{startDate:'desc'}});return rows.map(x=>({...x,rentMinor:x.rentMinor.toString()}));}
 @Post() async create(@Req() req:any,@Body() dto:CreateLeaseDto){
  if(!['OWNER','MANAGER'].includes(req.role))throw new ForbiddenException();
  const start=new Date(dto.startDate),end=new Date(dto.endDate);if(start>=end)throw new BadRequestException('End date must be after start date');
  return this.db.$transaction(async tx=>{
   const unit=await tx.unit.findFirst({where:{id:dto.unitId,building:{property:{organizationId:req.organizationId}}}});
   const tenant=await tx.tenant.findFirst({where:{id:dto.tenantId,organizationId:req.organizationId}});
   if(!unit||!tenant)throw new BadRequestException('Unit or tenant not in organization');
   // Atomic conditional update prevents two concurrent active leases on the same unit.
   const claim=await tx.unit.updateMany({where:{id:unit.id,status:'VACANT'},data:{status:'OCCUPIED'}});
   if(claim.count!==1)throw new BadRequestException('Unit is not vacant');
   const lease=await tx.lease.create({data:{organizationId:req.organizationId,unitId:unit.id,tenantId:tenant.id,startDate:start,endDate:end,rentMinor:BigInt(dto.rentMinor),status:'ACTIVE'}});
   return {...lease,rentMinor:lease.rentMinor.toString()};
  });
 }
}
